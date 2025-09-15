FROM python:3.12-slim

# Install dependencies for adding NodeSource repo and building native modules
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl ca-certificates gnupg build-essential \
    && rm -rf /var/lib/apt/lists/*

# Add NodeSource repository and install Node.js (change node_20.x to your desired major version)
RUN mkdir -p /etc/apt/keyrings \
    && curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg \
    && echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" > /etc/apt/sources.list.d/nodesource.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*


RUN python3 -m venv /venv

ENV PATH="/venv/bin:$PATH"

RUN pip install --upgrade pip && pip install llama-scan

WORKDIR /opt/app-root/src

COPY . .

RUN npm i

CMD ["npm", "run", "dev"]
