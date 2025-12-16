# ========================
# Dockerfile for AI Call Server
# ========================

# Use official Node.js LTS image
FROM node:20-slim

# Set working directory
WORKDIR /usr/src/app

# Install system dependencies (FFmpeg for audio processing)
RUN apt-get update && apt-get install -y \
    ffmpeg \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Copy package files first for caching npm install
COPY package*.json ./

# Install production dependencies
RUN npm install --production

# Copy the rest of the application
COPY . .

# Expose port (Render will set $PORT automatically)
ENV PORT 10000
EXPOSE $PORT

# Start the Node.js server
CMD ["node", "server.js"]
