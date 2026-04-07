const { CognitoIdentityProviderClient, InitiateAuthCommand, SignUpCommand, ConfirmSignUpCommand, ForgotPasswordCommand, ConfirmForgotPasswordCommand } = require('@aws-sdk/client-cognito-identity-provider');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

// Initialize Cognito client
const cognitoClient = new CognitoIdentityProviderClient({
    region: process.env.AWS_COGNITO_REGION,
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
    }
});

// Helper function to generate secret hash required by Cognito
function generateSecretHash(username, clientId, clientSecret) {
    return crypto
        .createHmac('SHA256', clientSecret)
        .update(username + clientId)
        .digest('base64');
}

// Authentication middleware - protects routes
function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

    if (!token) {
        return res.status(401).json({ error: 'Access token required' });
    }

    jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
        if (err) {
            return res.status(403).json({ error: 'Invalid or expired token' });
        }
        req.user = user;
        next();
    });
}

// Login function
async function loginUser(email, password, dbPool) {
    const secretHash = generateSecretHash(
        email, 
        process.env.AWS_COGNITO_CLIENT_ID, 
        process.env.AWS_COGNITO_CLIENT_SECRET
    );

    const command = new InitiateAuthCommand({
        AuthFlow: 'USER_PASSWORD_AUTH',
        ClientId: process.env.AWS_COGNITO_CLIENT_ID,
        AuthParameters: {
            USERNAME: email,
            PASSWORD: password,
            SECRET_HASH: secretHash
        }
    });

    const response = await cognitoClient.send(command);
    
    if (response.AuthenticationResult) {
        // Check user approval status in database
        const userResult = await dbPool.query(
            'SELECT * FROM users WHERE email = $1',
            [email]
        );

        if (userResult.rows.length === 0) {
            throw new Error('User not found in system. Please contact an administrator.');
        }

        const user = userResult.rows[0];
        
        if (user.status !== 'approved') {
            if (user.status === 'pending') {
                throw new Error('Your account is pending approval. Please wait for an administrator to approve your access.');
            } else if (user.status === 'rejected') {
                throw new Error('Your account has been rejected. Please contact an administrator.');
            } else {
                throw new Error('Your account status is unclear. Please contact an administrator.');
            }
        }

        // Create JWT token for approved user
        const token = jwt.sign(
            { 
                email: email,
                name: user.name,
                userId: user.id,
                isSuperUser: user.is_super_user,
                sub: response.AuthenticationResult.AccessToken,
                cognitoAccessToken: response.AuthenticationResult.AccessToken,
                cognitoIdToken: response.AuthenticationResult.IdToken
            },
            process.env.JWT_SECRET,
            { expiresIn: '24h' }
        );

        return {
            success: true,
            token: token,
            user: { 
                email: email, 
                name: user.name,
                isSuperUser: user.is_super_user
            }
        };
    } else {
        throw new Error('Authentication failed');
    }
}

// Register function
async function registerUser(email, password, name = null) {
    const secretHash = generateSecretHash(
        email, 
        process.env.AWS_COGNITO_CLIENT_ID, 
        process.env.AWS_COGNITO_CLIENT_SECRET
    );

    const userAttributes = [
        {
            Name: 'email',
            Value: email
        }
    ];

    if (name) {
        userAttributes.push({
            Name: 'name',
            Value: name
        });
    }

    const command = new SignUpCommand({
        ClientId: process.env.AWS_COGNITO_CLIENT_ID,
        Username: email,
        Password: password,
        SecretHash: secretHash,
        UserAttributes: userAttributes
    });

    const response = await cognitoClient.send(command);
    
    return {
        success: true,
        message: 'Registration successful. Please check your email for verification and wait for admin approval.',
        userSub: response.UserSub,
        requiresApproval: true
    };
}

// Confirm registration function
async function confirmRegistration(email, confirmationCode) {
    const secretHash = generateSecretHash(
        email, 
        process.env.AWS_COGNITO_CLIENT_ID, 
        process.env.AWS_COGNITO_CLIENT_SECRET
    );

    const command = new ConfirmSignUpCommand({
        ClientId: process.env.AWS_COGNITO_CLIENT_ID,
        Username: email,
        ConfirmationCode: confirmationCode,
        SecretHash: secretHash
    });

    await cognitoClient.send(command);
    
    return {
        success: true,
        message: 'Email confirmed successfully. You can now log in.'
    };
}

// Forgot password function
async function forgotPassword(email) {
    const secretHash = generateSecretHash(
        email, 
        process.env.AWS_COGNITO_CLIENT_ID, 
        process.env.AWS_COGNITO_CLIENT_SECRET
    );

    const command = new ForgotPasswordCommand({
        ClientId: process.env.AWS_COGNITO_CLIENT_ID,
        Username: email,
        SecretHash: secretHash
    });

    await cognitoClient.send(command);
    
    return {
        success: true,
        message: 'Password reset code sent to your email'
    };
}

// Reset password function
async function resetPassword(email, confirmationCode, newPassword) {
    const secretHash = generateSecretHash(
        email, 
        process.env.AWS_COGNITO_CLIENT_ID, 
        process.env.AWS_COGNITO_CLIENT_SECRET
    );

    const command = new ConfirmForgotPasswordCommand({
        ClientId: process.env.AWS_COGNITO_CLIENT_ID,
        Username: email,
        ConfirmationCode: confirmationCode,
        Password: newPassword,
        SecretHash: secretHash
    });

    await cognitoClient.send(command);
    
    return {
        success: true,
        message: 'Password reset successful'
    };
}

// Super user middleware
function requireSuperUser(req, res, next) {
    if (!req.user || !req.user.isSuperUser) {
        return res.status(403).json({ error: 'Super user access required' });
    }
    next();
}

// Create user in database (called after Cognito registration)
async function createUserInDB(email, name, cognitoSub, dbPool) {
    try {
        const result = await dbPool.query(
            `INSERT INTO users (email, name, cognito_sub, status, created_at) 
             VALUES ($1, $2, $3, 'pending', NOW()) 
             ON CONFLICT (email) DO NOTHING 
             RETURNING *`,
            [email, name || '', cognitoSub]
        );
        return result.rows[0];
    } catch (error) {
        console.error('Error creating user in DB:', error);
        throw error;
    }
}

// Get user by email
async function getUserByEmail(email, dbPool) {
    try {
        const result = await dbPool.query(
            'SELECT * FROM users WHERE email = $1',
            [email]
        );
        return result.rows[0];
    } catch (error) {
        console.error('Error getting user by email:', error);
        throw error;
    }
}

module.exports = {
    authenticateToken,
    requireSuperUser,
    loginUser,
    registerUser,
    confirmRegistration,
    forgotPassword,
    resetPassword,
    createUserInDB,
    getUserByEmail
};