FROM node:18-slim

RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    ffmpeg \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install yt-dlp
RUN pip3 install --no-cache-dir yt-dlp

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

EXPOSE 3000

CMD ["node", "server.js"]
