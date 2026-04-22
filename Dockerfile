FROM mcr.microsoft.com/playwright:v1.59.1-noble

WORKDIR /app

ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

EXPOSE 3000

CMD ["npm", "start"]
