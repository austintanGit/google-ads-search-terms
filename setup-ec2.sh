#!/bin/bash
# Run this script ONCE on the EC2 instance to set up the environment
# Usage: bash setup-ec2.sh

set -e

echo "=== 1. Update system ==="
sudo yum update -y 2>/dev/null || sudo apt-get update -y

echo "=== 2. Install Node.js 20 ==="
if ! command -v node &>/dev/null; then
  curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash - 2>/dev/null \
    || curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo yum install -y nodejs 2>/dev/null || sudo apt-get install -y nodejs
fi
echo "Node: $(node -v)  NPM: $(npm -v)"

echo "=== 3. Install PM2 globally ==="
sudo npm install -g pm2

echo "=== 4. Download RDS SSL certificate ==="
sudo mkdir -p /certs
sudo curl -sS https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem \
  -o /certs/global-bundle.pem
echo "SSL cert saved to /certs/global-bundle.pem"

echo "=== 5. Install app dependencies ==="
cd ~/google-ads-search-terms
npm install --omit=dev

echo ""
echo "=== Setup complete! ==="
echo ""
echo "Next steps:"
echo "  1. Create the .env file:  nano ~/google-ads-search-terms/.env"
echo "  2. Start the app:         pm2 start app.js --name google-ads-app"
echo "  3. Save pm2 on reboot:    pm2 save && pm2 startup"
