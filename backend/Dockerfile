FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY backend ./backend
COPY migrations ./migrations
COPY scripts ./scripts
COPY tsconfig.json ./

EXPOSE 3000

# Runs migrations and seeds if empty automatically on startup before listening
CMD ["sh", "-c", "npm run migrate && npm run seed:if-empty && npm start"]
