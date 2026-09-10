FROM node:18

WORKDIR /app

# bot folder එක ඇතුලේ තියෙන package files copy කරන්න
COPY bot/package*.json ./
RUN npm install --legacy-peer-deps

# bot folder එකේ ඉතිරි හැම දෙයක්ම copy කරන්න
COPY bot/ .

CMD ["node", "bot.js"]
