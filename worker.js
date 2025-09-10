const { Worker } = require('bullmq')
const { exec } = require('child_process')
const { promisify } = require('util')
const path = require('path')
const fs = require('fs/promises')
const os = require('os')
const crypto = require('crypto')
const { S3Client, GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3')
const { pipeline } = require('stream')
const { createWriteStream, createReadStream } = require('fs')

const execAsync = promisify(exec)
const pipelineAsync = promisify(pipeline)

// --- Helpers ---

async function getAllTxtFilesAsObject(dir) {
  let files
  try {
    files = await fs.readdir(dir)
  } catch (e) {
    if (e.code === 'ENOENT') return {}
    throw e
  }
  const txtFiles = files.filter(f => f.endsWith('.txt'))

  txtFiles.sort((a, b) => {
    const aMatch = a.match(/page_(\d+).txt/)
    const bMatch = b.match(/page_(\d+).txt/)
    const aNum = aMatch ? parseInt(aMatch[1], 10) : Number.MAX_SAFE_INTEGER
    const bNum = bMatch ? parseInt(bMatch[1], 10) : Number.MAX_SAFE_INTEGER
    return aNum - bNum
  })

  const result = {}
  for (const file of txtFiles) {
    const filePath = path.join(dir, file)
    const content = await fs.readFile(filePath, 'utf-8')
    result[file] = content
  }
  return result
}

function randomId(n = 8) {
  return crypto.randomBytes(n).toString('hex')
}

function ensureTrailingSlash(prefix) {
  if (!prefix) return ''
  return prefix.endsWith('/') ? prefix : `${prefix}/`
}

async function downloadS3ToFile(s3, bucket, key, destPath) {
  const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
  await fs.mkdir(path.dirname(destPath), { recursive: true })
  await pipelineAsync(res.Body, createWriteStream(destPath))
}

async function uploadFileToS3(s3, bucket, key, filePath, contentType) {
  const Body = createReadStream(filePath)
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body, ContentType: contentType }))
}

async function pathExists(p) {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

async function walkDir(rootDir) {
  const out = []
  async function walk(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    for (const e of entries) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) {
        await walk(full)
      } else if (e.isFile()) {
        out.push(full)
      }
    }
  }
  await walk(rootDir)
  return out
}

function guessContentType(filePath) {
  const ext = path.extname(filePath).toLowerCase()
  if (ext === '.txt') return 'text/plain charset=utf-8'
  if (ext === '.json') return 'application/json'
  if (ext === '.pdf') return 'application/pdf'
  if (ext === '.png') return 'image/png'
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg'
  if (ext === '.md') return 'text/markdown charset=utf-8'
  if (ext === '.csv') return 'text/csv charset=utf-8'
  return 'application/octet-stream'
}

// --- Config ---

const REDIS_HOST = process.env.REDIS_HOST
const REDIS_PORT = process.env.REDIS_PORT
const CA = process.env.CA
const CERT = process.env.CERT
const KEY = process.env.KEY

const connection = {
  host: REDIS_HOST,
  port: REDIS_PORT,
  tls: {
    ca: CA,
    cert: CERT,
    key: KEY,
    servername: REDIS_HOST,
  },
}

const QUEUE_NAME = process.env.LLAMA_SCAN_QUEUE || 'llama-scan-queue'
const S3_HOST = process.env.S3_HOST || ''
const S3_ACCESS_KEY = process.env.S3_ACCESS_KEY
const S3_SECRET_ACCESS_KEY = process.env.S3_SECRET_ACCESS_KEY

const s3 = new S3Client({
  region: 'eu-north-1',
  endpoint: S3_HOST,
  forcePathStyle: true,
  credentials: {
    accessKeyId: S3_ACCESS_KEY,
    secretAccessKey: S3_SECRET_ACCESS_KEY,
  },
})

// --- Worker ---

const worker = new Worker(
  QUEUE_NAME,
  async (job) => {
    const {
      s3Bucket,
      s3Key,
      outputBucket,
      outputPrefix // optional
    } = job.data || {}

    if (!s3Bucket || !s3Key) {
      throw new Error('s3Bucket and s3Key are required in job data')
    }
    if (!outputBucket) {
      throw new Error('outputBucket is required in job data')
    }

    const prefix = ensureTrailingSlash(outputPrefix || '')

    const tempRoot = path.join(os.tmpdir(), `llama-scan-${randomId()}`)
    const inputLocalPath = path.join(tempRoot, 'input', path.basename(s3Key))
    const outputBaseDir = path.join(tempRoot, 'output')
    const outputTextDir = path.join(outputBaseDir, 'text')

    await fs.mkdir(path.dirname(inputLocalPath), { recursive: true })
    await fs.mkdir(outputBaseDir, { recursive: true })

    try {
      await downloadS3ToFile(s3, s3Bucket, s3Key, inputLocalPath)
    } catch (err) {
      throw new Error(`Failed to download s3://${s3Bucket}/${s3Key}: ${err.message || err}`)
    }

    const llamaCmd = `llama-scan "${inputLocalPath}" --output "${outputBaseDir}"`
    try {
      const res = await execAsync(llamaCmd, { maxBuffer: 1024 * 1024 * 64 })
      if (res.stderr && res.stderr.trim()) {
        console.warn('llama-scan stderr:', res.stderr)
      }
    } catch (err) {
      try { await fs.unlink(inputLocalPath) } catch { }
      throw new Error(`llama-scan failed: ${err.stderr || err.message || err}`)
    }

    let textData = {}
    try {
      textData = await getAllTxtFilesAsObject(outputTextDir)
    } catch (err) {
      console.error('Failed reading text outputs:', err)
    }

    let uploadedKeys = []
    try {
      const files = (await pathExists(outputBaseDir)) ? await walkDir(outputBaseDir) : []
      for (const filePath of files) {
        const rel = path.relative(outputBaseDir, filePath).split(path.sep).join('/')
        const key = `${prefix}${rel}`
        await uploadFileToS3(s3, outputBucket, key, filePath, guessContentType(filePath))
        uploadedKeys.push(key)
      }
    } catch (err) {
      console.error('Failed uploading outputs to S3:', err)
      throw new Error(`Failed uploading outputs to s3://${outputBucket}/${prefix}: ${err.message || err}`)
    } finally {
      try { await fs.rm(tempRoot, { recursive: true, force: true }) } catch { }
    }

    return {
      input: { bucket: s3Bucket, key: s3Key },
      output: { bucket: outputBucket, prefix },
      uploadedCount: uploadedKeys.length,
      uploadedKeys,
      textData
    }

  },
  {
    redis: connection,
    concurrency: parseInt(process.env.WORKER_CONCURRENCY || '2', 10)
  }
)

worker.on('completed', (job, result) => {
  console.log(`Job ${job.id} completed.Uploaded ${result?.uploadedCount || 0} files to s3://${result?.output?.bucket}/${result?.output?.prefix}`)
})

worker.on('failed', (job, err) => {
  console.error(`Job ${job?.id} failed:`, err)
})

async function shutdown() {
  console.log('Shutting down worker...')
  try { await worker.close() } catch { }
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

module.exports = { worker }
