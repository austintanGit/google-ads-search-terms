#!/bin/bash

# Upload script - run this from your local machine
# Usage: ./upload.sh your-ec2-ip-address path/to/your-key.pem

if [ $# -ne 2 ]; then
    echo "Usage: $0 <EC2_IP_ADDRESS> <PATH_TO_PEM_KEY>"
    echo "Example: $0 3.15.123.456 ~/.ssh/my-key.pem"
    exit 1
fi

EC2_IP=$1
PEM_KEY=$2

echo "🔄 Building frontend..."
cd frontend && npm run build && cd ..

echo "📦 Creating deployment package..."
tar -czf app.tar.gz \
  --exclude=node_modules \
  --exclude=frontend/node_modules \
  --exclude=frontend/dist \
  --exclude=.git \
  --exclude=*.log \
  --exclude=.env \
  --exclude=.DS_Store \
  .

echo "⬆️  Uploading to EC2..."
scp -i "$PEM_KEY" app.tar.gz ubuntu@$EC2_IP:~/
scp -i "$PEM_KEY" .env.production ubuntu@$EC2_IP:~/.env

echo "🚀 Deploying on EC2..."
ssh -i "$PEM_KEY" ubuntu@$EC2_IP << 'EOF'
  # Extract files
  sudo rm -rf /opt/google-ads-app/*
  cd /opt/google-ads-app
  sudo tar -xzf ~/app.tar.gz
  sudo cp ~/.env /opt/google-ads-app/.env
  sudo chown -R $USER:$USER /opt/google-ads-app
  
  # Install dependencies
  npm ci --only=production
  
  # Build frontend
  cd frontend
  npm ci
  npm run build
  cd ..
  
  # Restart with PM2
  pm2 restart google-ads-app || pm2 start ecosystem.config.js --env production
  
  # Cleanup
  rm ~/app.tar.gz ~/.env
EOF

echo "✅ Deployment complete!"
echo "🌐 Your app should be running at http://$EC2_IP:3000"

# Cleanup local files
rm app.tar.gz