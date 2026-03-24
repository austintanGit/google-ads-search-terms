#!/bin/bash

# AWS EC2 Ubuntu Deployment Script for Google Ads Negative Keyword Tool

set -e

echo "🚀 Starting deployment..."

# Update system
sudo apt update && sudo apt upgrade -y

# Install Node.js 18
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs

# Install PM2 for process management
sudo npm install -g pm2

# Create app directory
sudo mkdir -p /opt/google-ads-app
sudo chown $USER:$USER /opt/google-ads-app

# Copy files (run this from your local machine after uploading)
cd /opt/google-ads-app

# Install dependencies
npm ci --only=production

# Install frontend dependencies and build
cd frontend
npm ci
npm run build
cd ..

# Create PM2 ecosystem file
cat > ecosystem.config.js << 'EOF'
module.exports = {
  apps: [{
    name: 'google-ads-app',
    script: 'app.js',
    instances: 1,
    exec_mode: 'cluster',
    env: {
      NODE_ENV: 'development'
    },
    env_production: {
      NODE_ENV: 'production',
      PORT: 3000
    },
    error_file: '/var/log/pm2/google-ads-app.error.log',
    out_file: '/var/log/pm2/google-ads-app.out.log',
    log_file: '/var/log/pm2/google-ads-app.log',
    time: true
  }]
}
EOF

# Create log directory
sudo mkdir -p /var/log/pm2
sudo chown $USER:$USER /var/log/pm2

# Start the application
pm2 start ecosystem.config.js --env production

# Save PM2 configuration
pm2 save

# Setup PM2 to start on boot
sudo env PATH=$PATH:/usr/bin /usr/lib/node_modules/pm2/bin/pm2 startup systemd -u $USER --hp $HOME

echo "✅ Deployment complete!"
echo "🌐 App should be running on port 3000"
echo "📊 Monitor with: pm2 monit"
echo "📜 View logs with: pm2 logs google-ads-app"