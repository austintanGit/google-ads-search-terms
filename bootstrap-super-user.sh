#!/bin/bash

# Bootstrap First Super User Script
# This script creates the first super user account for the system

echo "🚀 Bootstrap First Super User"
echo "================================="
echo ""

# Prompt for super user details
read -p "Enter super user email: " SUPER_USER_EMAIL
read -p "Enter super user name (optional): " SUPER_USER_NAME

if [ -z "$SUPER_USER_EMAIL" ]; then
    echo "❌ Error: Email is required"
    exit 1
fi

# Database connection details from .env
if [ -f .env ]; then
    export $(cat .env | grep -E '^(DB_HOST|DB_PORT|DB_NAME|DB_USER|DB_PASSWORD)=' | xargs)
else
    echo "❌ Error: .env file not found"
    exit 1
fi

# SQL to insert super user
SQL="INSERT INTO users (email, name, status, is_super_user, approved_at, created_at) 
     VALUES ('$SUPER_USER_EMAIL', '$SUPER_USER_NAME', 'approved', true, NOW(), NOW()) 
     ON CONFLICT (email) DO UPDATE SET 
         is_super_user = true, 
         status = 'approved', 
         approved_at = NOW(),
         updated_at = NOW()
     RETURNING id, email, name, is_super_user, status;"

# Execute SQL
echo "Creating super user account..."
echo ""

if command -v psql &> /dev/null; then
    # Using psql
    PGPASSWORD="$DB_PASSWORD" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -c "$SQL"
    if [ $? -eq 0 ]; then
        echo ""
        echo "✅ Super user created successfully!"
        echo ""
        echo "📝 Next Steps:"
        echo "1. The super user can now register through the normal signup process"
        echo "2. Their account will be automatically approved"
        echo "3. They can access the admin panel at /admin"
        echo "4. They can approve other pending users"
    else
        echo "❌ Error creating super user"
        exit 1
    fi
else
    echo "📋 Manual SQL (psql not available):"
    echo "Please run this SQL in your PostgreSQL database:"
    echo ""
    echo "$SQL"
    echo ""
    echo "Or use your preferred database client to execute the above SQL."
fi

echo ""
echo "🔐 Security Notes:"
echo "- The super user still needs to register through AWS Cognito"
echo "- Their email confirmation is still required"
echo "- Only grant super user access to trusted administrators"
echo ""