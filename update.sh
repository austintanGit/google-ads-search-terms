#!/bin/bash

# Quick update script for existing EC2 deployment
# Usage: ./update.sh your-ec2-ip-address path/to/your-key.pem

if [ $# -ne 2 ]; then
    echo "Usage: $0 <EC2_IP_ADDRESS> <PATH_TO_PEM_KEY>"
    echo "Example: $0 3.15.123.456 ~/.ssh/my-key.pem"
    exit 1
fi

EC2_IP=$1
PEM_KEY=$2

echo "🔄 Building React frontend..."
cd frontend && npm ci && npm run build && cd ..

echo "📦 Creating update package..."
tar -czf update.tar.gz \
  --exclude=node_modules \
  --exclude=frontend/node_modules \
  --exclude=.git \
  --exclude=*.log \
  --exclude=.env \
  --exclude=.DS_Store \
  .

echo "⬆️  Uploading to EC2..."
scp -i "$PEM_KEY" update.tar.gz ubuntu@$EC2_IP:~/
scp -i "$PEM_KEY" .env.production ubuntu@$EC2_IP:~/.env.production

echo "🔄 Updating on EC2..."
ssh -i "$PEM_KEY" ubuntu@$EC2_IP << 'EOF'
  APP_DIR="/home/ubuntu/google-ads-search-terms"

  # Stop current app
  pm2 stop all || echo "No PM2 processes running"

  # Extract new version over existing app
  cd "$APP_DIR"
  tar -xzf ~/update.tar.gz
  cp ~/.env.production .env

  # Install backend dependencies
  npm ci --only=production

  # Build frontend
  cd frontend
  npm ci
  npm run build

  # Copy built frontend to public directory (if not done by build)
  cd ..
  mkdir -p public
  cp -r frontend/dist/* public/ 2>/dev/null || echo "Frontend build output already in correct location"

  # Create/update PM2 ecosystem if doesn't exist
  if [ ! -f ecosystem.config.js ]; then
    cat > ecosystem.config.js << 'EOL'
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
EOL
  fi

  # Start the updated application
  pm2 start ecosystem.config.js --env production || pm2 restart google-ads-app
  pm2 save

  # Cleanup
  rm ~/update.tar.gz ~/.env.production

  echo "✅ Update complete!"
  echo "📊 App status:"
  pm2 status
EOF

echo "🎉 Update deployed successfully!"
echo "🌐 Your app should be running at http://$EC2_IP:3000"

# Cleanup
rm update.tar.gz