const express = require('express');
const { google } = require('googleapis');
require('dotenv').config();

const app = express();

// Create OAuth2 client with exact URI match
const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_ADS_CLIENT_ID,
    process.env.GOOGLE_ADS_CLIENT_SECRET,
    'http://localhost:3000/oauth2callback'  // Changed to standard OAuth callback path
);

// Generate authentication URL with all necessary parameters
const scopes = ['https://www.googleapis.com/auth/adwords'];
const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: scopes,
    prompt: 'consent select_account',  // Force account selection and consent
    include_granted_scopes: true
});

// Debug route to show current credentials
app.get('/debug', (req, res) => {
    res.send(`
        <h1>Current Configuration:</h1>
        <p>Client ID: ${process.env.GOOGLE_ADS_CLIENT_ID ? 'Set' : 'Not Set'}</p>
        <p>Client Secret: ${process.env.GOOGLE_ADS_CLIENT_SECRET ? 'Set' : 'Not Set'}</p>
        <p>Redirect URI: http://localhost:3000/oauth2callback</p>
    `);
});

// Main route
app.get('/', (req, res) => {
    console.log('Auth URL:', authUrl); // Debug log
    res.redirect(authUrl);
});

// OAuth callback route
app.get('/oauth2callback', async (req, res) => {
    const { code, error } = req.query;

    if (error) {
        return res.send(`
            <h1>Authentication Error</h1>
            <p>Error: ${error}</p>
            <p>Please make sure you've configured your OAuth credentials correctly in Google Cloud Console.</p>
        `);
    }

    if (!code) {
        return res.send(`
            <h1>No Authorization Code</h1>
            <p>No authorization code was received from Google.</p>
        `);
    }

    try {
        const { tokens } = await oauth2Client.getToken(code);
        
        if (!tokens.refresh_token) {
            return res.send(`
                <h1>No Refresh Token Received</h1>
                <p>Try revoking the app's access in your Google Account settings and try again.</p>
                <p>Or clear your browser cookies and try in an incognito window.</p>
            `);
        }

        res.send(`
            <h1>Success! Your Refresh Token:</h1>
            <p style="word-break: break-all; background: #f0f0f0; padding: 10px; border-radius: 4px;">
                <strong>${tokens.refresh_token}</strong>
            </p>
            <p>Add this to your .env file as:</p>
            <pre>GOOGLE_ADS_REFRESH_TOKEN=${tokens.refresh_token}</pre>
            <p>Also received:</p>
            <ul>
                <li>Access Token (expires in ${tokens.expiry_date ? Math.floor((tokens.expiry_date - Date.now()) / 1000) : 'unknown'} seconds)</li>
                <li>Token Type: ${tokens.token_type}</li>
            </ul>
        `);
    } catch (error) {
        console.error('Token Error:', error);
        res.send(`
            <h1>Error Getting Token</h1>
            <p>Error: ${error.message}</p>
            <p>Stack: ${error.stack}</p>
        `);
    }
});

const port = 3000;
app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
    console.log(`Make sure this redirect URI is authorized in Google Cloud Console:`);
    console.log(`http://localhost:${port}/oauth2callback`);
});