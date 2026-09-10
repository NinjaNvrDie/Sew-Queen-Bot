FROM ubuntu:latest

# Update and install required packages
RUN apt-get update && apt-get install -y \
    jq \
    git \
    curl \
    npm \
    wget \
    ffmpeg \
    bpm-tools \
    python3-pip \
    python-is-python3 \
    imagemagick \
    webp \
    && rm -rf /var/lib/apt/lists/*

# Install n package manager for managing Node.js versions
RUN npm install -g n

# 🌟 වෙනස: Baileys 7.x සඳහා Node.js 20 අනිවාර්යයි (18 වෙනුවට 20)
RUN n 20

# Install Yarn package manager (just in case commands need it)
RUN npm install -g yarn

# Set the working directory
WORKDIR /app

# 1. ඔබේ bot folder එකේ package.json එක ගන්න
COPY bot/package*.json ./

# 2. Packages install කරන්න
RUN npm install --legacy-peer-deps

# 3. ඔබේ bot folder එකේ ඉතිරි හැම දෙයක්ම copy කරන්න (bot.js ඇතුළු)
COPY bot/ .

# 4. sew_queen_src folder එකත් එහෙම්මම copy කරන්න (commands වැඩ කරන්න මේක අනිවාර්යයි)
COPY sew_queen_src/ ./sew_queen_src/

# 5. ඔබේ බෝට් එක start කරන්න
CMD [ "node", "bot.js" ]
