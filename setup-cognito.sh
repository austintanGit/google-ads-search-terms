#!/bin/bash

# AWS Cognito Setup Script for Google Ads Search Terms App
echo "Setting up AWS Cognito User Pool and Client..."

# Check if AWS CLI is configured
if ! command -v aws &> /dev/null; then
    echo "AWS CLI not found. Please install and configure AWS CLI first."
    exit 1
fi

# Set variables
USER_POOL_NAME="google-ads-search-terms-users"
CLIENT_NAME="google-ads-search-terms-client"
REGION="us-east-1"  # Change this if you prefer a different region

echo "Creating User Pool: $USER_POOL_NAME"

# Create User Pool
USER_POOL_RESPONSE=$(aws cognito-idp create-user-pool \
    --pool-name "$USER_POOL_NAME" \
    --region "$REGION" \
    --policies '{
        "PasswordPolicy": {
            "MinimumLength": 8,
            "RequireUppercase": true,
            "RequireLowercase": true,
            "RequireNumbers": true,
            "RequireSymbols": false
        }
    }' \
    --auto-verified-attributes email \
    --username-attributes email \
    --schema '[
        {
            "Name": "email",
            "AttributeDataType": "String",
            "Mutable": true,
            "Required": true
        },
        {
            "Name": "name",
            "AttributeDataType": "String",
            "Mutable": true,
            "Required": false
        }
    ]' \
    --email-configuration '{
        "EmailSendingAccount": "COGNITO_DEFAULT"
    }' \
    --admin-create-user-config '{
        "AllowAdminCreateUserOnly": false,
        "UnusedAccountValidityDays": 7
    }' \
    --user-pool-tags '{
        "Environment": "production",
        "Application": "google-ads-search-terms"
    }' \
    --output json)

if [ $? -ne 0 ]; then
    echo "Failed to create User Pool"
    exit 1
fi

USER_POOL_ID=$(echo "$USER_POOL_RESPONSE" | jq -r '.UserPool.Id')
echo "✓ User Pool created: $USER_POOL_ID"

# Create User Pool Client
echo "Creating User Pool Client: $CLIENT_NAME"

CLIENT_RESPONSE=$(aws cognito-idp create-user-pool-client \
    --user-pool-id "$USER_POOL_ID" \
    --client-name "$CLIENT_NAME" \
    --region "$REGION" \
    --generate-secret \
    --explicit-auth-flows "ADMIN_NO_SRP_AUTH" "USER_PASSWORD_AUTH" "ALLOW_USER_SRP_AUTH" "ALLOW_REFRESH_TOKEN_AUTH" \
    --supported-identity-providers "COGNITO" \
    --read-attributes "email" "name" \
    --write-attributes "email" "name" \
    --token-validity-units '{
        "AccessToken": "hours",
        "IdToken": "hours",
        "RefreshToken": "days"
    }' \
    --access-token-validity 24 \
    --id-token-validity 24 \
    --refresh-token-validity 30 \
    --prevent-user-existence-errors "ENABLED" \
    --output json)

if [ $? -ne 0 ]; then
    echo "Failed to create User Pool Client"
    exit 1
fi

CLIENT_ID=$(echo "$CLIENT_RESPONSE" | jq -r '.UserPoolClient.ClientId')
CLIENT_SECRET=$(echo "$CLIENT_RESPONSE" | jq -r '.UserPoolClient.ClientSecret')

echo "✓ User Pool Client created: $CLIENT_ID"

# Create .env.cognito file with the credentials
echo "Creating .env.cognito file with your Cognito configuration..."

cat > .env.cognito << EOF
# AWS Cognito Configuration for Google Ads Search Terms App
# Add these variables to your main .env file

AWS_COGNITO_USER_POOL_ID=$USER_POOL_ID
AWS_COGNITO_CLIENT_ID=$CLIENT_ID
AWS_COGNITO_CLIENT_SECRET=$CLIENT_SECRET
AWS_COGNITO_REGION=$REGION
JWT_SECRET=$(openssl rand -base64 32)

# User Pool ARN (for reference)
AWS_COGNITO_USER_POOL_ARN=arn:aws:cognito-idp:$REGION:$(aws sts get-caller-identity --query Account --output text):userpool/$USER_POOL_ID
EOF

echo ""
echo "🎉 AWS Cognito setup completed successfully!"
echo ""
echo "📋 Configuration Details:"
echo "  User Pool ID: $USER_POOL_ID"
echo "  Client ID: $CLIENT_ID"
echo "  Region: $REGION"
echo ""
echo "📝 Next Steps:"
echo "1. Review the .env.cognito file that was created"
echo "2. Copy the environment variables from .env.cognito to your main .env file"
echo "3. Keep your Client Secret secure and never commit it to version control"
echo ""
echo "⚠️  Important Security Notes:"
echo "- The Client Secret is sensitive - store it securely"
echo "- Add .env.cognito to your .gitignore file"
echo "- The JWT_SECRET was randomly generated - keep it secure"
echo ""

# Show the created resources
echo "🔍 Verifying resources..."
aws cognito-idp describe-user-pool --user-pool-id "$USER_POOL_ID" --region "$REGION" --query 'UserPool.{Name:Name,Id:Id,Status:Status}' --output table
aws cognito-idp describe-user-pool-client --user-pool-id "$USER_POOL_ID" --client-id "$CLIENT_ID" --region "$REGION" --query 'UserPoolClient.{ClientName:ClientName,ClientId:ClientId}' --output table