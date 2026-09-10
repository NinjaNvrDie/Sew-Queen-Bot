FROM node:18

WORKDIR /app

COPY package*.json ./

# මේක තමයි වැදගත්ම වෙනස්කම
RUN npm install --legacy-peer-deps

COPY . .

CMD ["node", "bot.js"]
