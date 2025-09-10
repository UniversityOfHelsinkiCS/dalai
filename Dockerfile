FROM node:22-alpine

RUN apk add --no-cache socat python3 py3-pip

RUN python3 -m venv /venv

ENV PATH="/venv/bin:$PATH"

RUN pip install --upgrade pip && pip install llama-scan

WORKDIR /app
COPY . .

RUN npm i

RUN mkdir -p /app/uploads && chmod 777 /app/uploads

RUN chmod 777 -R . 

EXPOSE 3000

USER 1001

CMD ["node", "worker.js"]
