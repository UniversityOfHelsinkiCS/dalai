FROM node:22-alpine

RUN apk add --no-cache python3 py3-pip

RUN python3 -m venv /venv

ENV PATH="/venv/bin:$PATH"

RUN pip install --upgrade pip && pip install llama-scan

WORKDIR /opt/app-root/src

COPY . .

RUN npm i

CMD ["npm", "run", "dev"]
