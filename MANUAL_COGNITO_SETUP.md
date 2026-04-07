# Manual AWS Cognito Setup via Console

Since your current AWS user doesn't have Cognito CLI permissions, let's create the resources via the AWS Console.

## Step-by-Step Console Setup

### 1. Go to AWS Cognito Console
- Open https://console.aws.amazon.com/cognito/
- Make sure you're in the correct region (us-east-1 recommended)

### 2. Create User Pool
1. Click "Create user pool"
2. **Step 1 - Configure sign-in experience**:
   - Authentication providers: ✅ Cognito user pool
   - Cognito user pool sign-in options: ✅ Email
   - Click "Next"

3. **Step 2 - Configure security requirements**:
   - Password policy:
     - Password minimum length: 8
     - ✅ Contains at least 1 uppercase letter
     - ✅ Contains at least 1 lowercase letter  
     - ✅ Contains at least 1 number
     - ❌ Contains at least 1 special character
   - Multi-factor authentication: No MFA (for now)
   - Click "Next"

4. **Step 3 - Configure sign-up experience**:
   - Self-service sign-up: ✅ Enable self-registration
   - Attribute verification and user account confirmation:
     - ✅ Allow Cognito to automatically send messages to verify and confirm
     - Attributes to verify: ✅ Send email verification message
   - Required attributes: ✅ email
   - Optional attributes: ✅ name
   - Click "Next"

5. **Step 4 - Configure message delivery**:
   - Email: ✅ Send email with Cognito
   - (For production, you might want to use SES later)
   - Click "Next"

6. **Step 5 - Integrate your app**:
   - User pool name: `google-ads-search-terms-users`
   - ✅ Use the Cognito Hosted UI: No (we'll build our own)
   - Initial app client:
     - App client name: `google-ads-search-terms-client`
     - ✅ Generate a client secret
     - Authentication flows:
       - ✅ ALLOW_USER_PASSWORD_AUTH
       - ✅ ALLOW_USER_SRP_AUTH
       - ✅ ALLOW_REFRESH_TOKEN_AUTH
   - Click "Next"

7. **Step 6 - Review and create**:
   - Review all settings
   - Click "Create user pool"

### 3. Collect Your Configuration

After creation, you'll need to collect these values:

1. **User Pool ID**: 
   - Go to your newly created user pool
   - Copy the "User pool ID" from the overview page

2. **Client ID and Secret**:
   - In your user pool, go to "App integration" tab
   - Click on your app client name
   - Copy the "Client ID"
   - Click "Show client secret" and copy it

3. **Region**: The region where you created the pool (e.g., us-east-1)

### 4. Create Your .env Configuration

Create a `.env.cognito` file with your values:

```env
# Replace these with your actual values from the console
AWS_COGNITO_USER_POOL_ID=us-east-1_XXXXXXXXX
AWS_COGNITO_CLIENT_ID=your-actual-client-id
AWS_COGNITO_CLIENT_SECRET=your-actual-client-secret
AWS_COGNITO_REGION=us-east-1
JWT_SECRET=your-random-32-character-secret-here
```

### 5. Generate JWT Secret

Run this command to generate a secure JWT secret:

```bash
openssl rand -base64 32
```

Add this value to your JWT_SECRET in the .env.cognito file.

### 6. Update Your Main .env File

Copy the AWS Cognito variables from .env.cognito to your main .env file.

## What to Do Next

Once you have the Cognito configuration:
1. ✅ Copy values to main .env file
2. ✅ Add .env.cognito to .gitignore
3. ✅ Install backend dependencies
4. ✅ Implement authentication middleware
5. ✅ Create frontend login components

Let me know when you have the Cognito resources created and I'll help you implement the authentication code!