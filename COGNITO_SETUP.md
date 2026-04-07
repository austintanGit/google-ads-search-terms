# AWS Cognito Setup Guide

This guide will help you set up AWS Cognito for the Google Ads Search Terms application.

## Option 1: Automated Setup (Recommended)

Run the provided script to automatically create the Cognito resources:

```bash
# Make sure you're in the project directory
cd /Users/austintan/MediaCaptain/TMC/Google\ Ads/google-ads-search-terms

# Run the setup script
./setup-cognito.sh
```

### Prerequisites for Automated Setup:
1. AWS CLI installed and configured with appropriate permissions
2. `jq` command-line JSON processor (install with: `brew install jq` on macOS)
3. AWS credentials configured (either via `aws configure` or IAM role)

### Required AWS Permissions:
- `cognito-idp:CreateUserPool`
- `cognito-idp:CreateUserPoolClient`
- `cognito-idp:DescribeUserPool`
- `cognito-idp:DescribeUserPoolClient`
- `sts:GetCallerIdentity`

## Option 2: Manual Setup via AWS Console

If you prefer to set up manually or the script doesn't work, follow these steps:

### Step 1: Create User Pool

1. Go to AWS Console > Cognito > User Pools
2. Click "Create user pool"
3. Configure sign-in options:
   - **Sign-in options**: Email
   - **User name requirements**: Allow users to sign in with email
4. Configure security requirements:
   - **Password policy**: 
     - Minimum length: 8 characters
     - Require uppercase letters: Yes
     - Require lowercase letters: Yes
     - Require numbers: Yes
     - Require symbols: No
   - **Multi-factor authentication**: Optional (or required if you want extra security)
5. Configure sign-up experience:
   - **Self-service sign-up**: Enabled
   - **Required attributes**: Email
   - **Optional attributes**: Name
6. Configure message delivery:
   - **Email provider**: Send email with Cognito (for development)
   - For production, consider using Amazon SES
7. Integrate your app:
   - **User pool name**: `google-ads-search-terms-users`
   - **App client name**: `google-ads-search-terms-client`
   - **Client secret**: Generate a client secret
   - **Auth flows**: 
     - ✅ ALLOW_USER_PASSWORD_AUTH
     - ✅ ALLOW_USER_SRP_AUTH  
     - ✅ ALLOW_REFRESH_TOKEN_AUTH
     - ✅ ALLOW_ADMIN_USER_PASSWORD_AUTH

### Step 2: Note Your Configuration

After creation, note these values:
- **User Pool ID**: Found in the User Pool overview
- **Client ID**: Found in App Integration > App clients
- **Client Secret**: Found in App Integration > App clients (show secret)
- **Region**: The AWS region where you created the pool

### Step 3: Create Environment Configuration

Create a `.env.cognito` file with your values:

```env
AWS_COGNITO_USER_POOL_ID=us-east-1_XXXXXXXXX
AWS_COGNITO_CLIENT_ID=your-client-id-here
AWS_COGNITO_CLIENT_SECRET=your-client-secret-here
AWS_COGNITO_REGION=us-east-1
JWT_SECRET=your-random-jwt-secret-here
```

## After Setup

1. Copy the environment variables from `.env.cognito` to your main `.env` file
2. Add `.env.cognito` to your `.gitignore` file for security
3. Test the setup by running the application with authentication enabled

## Security Notes

- ⚠️ **Never commit the Client Secret to version control**
- 🔒 **Store the JWT_SECRET securely**
- 📝 **Add .env.cognito to .gitignore**
- 🛡️ **Use HTTPS in production**
- 🔐 **Consider enabling MFA for production use**

## Troubleshooting

### Common Issues:

1. **AWS CLI not configured**: Run `aws configure` to set up your credentials
2. **Permission denied**: Ensure your AWS user has Cognito permissions
3. **jq not found**: Install with `brew install jq` (macOS) or `sudo apt-get install jq` (Ubuntu)
4. **Region mismatch**: Ensure all resources are in the same region

### Verification Commands:

```bash
# Check if User Pool exists
aws cognito-idp describe-user-pool --user-pool-id YOUR_USER_POOL_ID

# List User Pool clients
aws cognito-idp list-user-pool-clients --user-pool-id YOUR_USER_POOL_ID
```

## Next Steps

After completing Cognito setup:
1. Install required dependencies
2. Implement backend authentication middleware
3. Create frontend authentication components
4. Add authentication to existing API endpoints
5. Test the complete authentication flow