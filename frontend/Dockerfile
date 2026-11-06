FROM node:22-slim
WORKDIR /app
COPY package.json server.js ./
COPY src ./src
ENV NODE_ENV=production
# Set API_URL to the public address of the backend, e.g. https://api.example.com
EXPOSE 5173
CMD ["node", "server.js"]
