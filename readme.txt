https://ads.google.com/aw/negativekeywordlistdetails?ocid=98788879&ascid=98788879&sharedSetId=1757631003&sharedSetCustomerId=98788879&euid=84357607&__u=8823743343&uscid=84819007&__c=7742471943&authuser=2&subid=us-en-ha-awa-bk-c-lc0%21o3-ahpm-0000000200-0000000002%7C-ahpm-0000000179-0000000001~CjwKCAjw687NBhB4EiwAQ645dgKhZ7mogxs_E8zb_rzF09SB3Zo_ah5SFyTVNt8LD693DmYMKuxsFxoCoi8QAvD_BwE~137408560317~kwd-94527731~17414652933~746968049738

./update.sh 3.137.119.68 tmc-search-term.pem


Deploy / dev
Production (PM2):

pm2 restart ecosystem.config.js   # starts both google-ads-app and google-ads-ai-worker
Local dev:

npm run dev   # api + worker + Vite UI
Worker only:

npm run start:worker

//--------
Commands to use next time
Always run PM2 from the app directory:

cd google-ads-search-terms
pm2 restart ecosystem.config.js --env production
pm2 save
pm2 status

#Or start fresh after a deploy:
cd google-ads-search-terms
pm2 stop all
pm2 start ecosystem.config.js --env production
pm2 save
