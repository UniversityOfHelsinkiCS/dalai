const express = require('express');
const multer = require('multer');
const { exec } = require('child_process');
const path = require('path');
const fs = require('fs').promises;

const upload = multer({ dest: 'uploads/' });
const app = express();

async function getAllTxtFilesAsObject(dir) {
  const files = await fs.readdir(dir);
  const txtFiles = files.filter(f => f.endsWith('.txt'));

  // Sort by number if possible (optional)
  txtFiles.sort((a, b) => {
    const aNum = parseInt(a.match(/page_(\d+)\.txt/)[1]);
    const bNum = parseInt(b.match(/page_(\d+)\.txt/)[1]);
    return aNum - bNum;
  });

  const result = {};
  for (const file of txtFiles) {
    const filePath = path.join(dir, file);
    const content = await fs.readFile(filePath, 'utf-8');
    result[file] = content;
  }
  return result;
}

app.post('/scan', upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No PDF file uploaded' });
  }

  try {
    const inputPath = req.file.path;
    const pdfBase = path.basename(inputPath, path.extname(inputPath));
    const outputBaseDir = path.join(__dirname, 'uploads', 'output', pdfBase);
    const outputTextDir = path.join(outputBaseDir, 'text');

    const llamaCmd = `llama-scan ${inputPath} --output ${outputBaseDir}`;

    exec(llamaCmd, async (error, stdout, stderr) => {
      if (error) {
        console.error('llama-scan error:', stderr);
        await fs.unlink(inputPath);
        return res.status(500).json({ error: 'llama-scan failed', details: stderr });
      }
      try {
        const data = await getAllTxtFilesAsObject(outputTextDir)
        return res.json(data)
      } catch (readErr) {
        console.error('File read error:', readErr);
        await fs.unlink(inputPath);
        return res.status(500).json({ error: 'Failed to read dir', details: readErr.message });
      }
    });

  } catch (err) {
    console.error(err);
    await fs.unlink(req.file.path);
    return res.status(500).json({ error: 'Unknown server error', details: err.message });
  }
});

const PORT = 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
