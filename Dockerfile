# Use official Node.js LTS image
FROM node:20-slim

# Install FFmpeg
RUN apt-get update && apt-get install -y ffmpeg

# Set working directory
WORKDIR /usr/src/app

# Copy package files and install dependencies
COPY package*.json ./
RUN npm install --production

# Copy the rest of your app
COPY . .

# Expose port (Render will use $PORT environment variable)
ENV PORT 10000
EXPOSE $PORT

# Start the app
CMD ["node", "server.js"]
