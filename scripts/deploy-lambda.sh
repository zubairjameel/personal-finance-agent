#!/usr/bin/env bash

set -euo pipefail

# ============================================================
# Personal Finance Agent
# AWS Lambda + EventBridge deployment
# ============================================================

FUNCTION_NAME="personal-finance-agent-heartbeat"
ROLE_NAME="personal-finance-agent-lambda-role"

REGION="${AWS_REGION:-ap-southeast-1}"

RUNTIME="nodejs20.x"
HANDLER="handler.handler"

MEMORY_SIZE=256
TIMEOUT=60

RULE_NAME="personal-finance-agent-heartbeat"
SCHEDULE_EXPRESSION="rate(5 minutes)"

BUILD_DIR="dist-lambda"
PACKAGE_DIR="${BUILD_DIR}/package"
ZIP_FILE="lambda-deploy.zip"

ENV_FILE=".env.local"

# ------------------------------------------------------------
# Helpers
# ------------------------------------------------------------

require_command() {
    if ! command -v "$1" >/dev/null 2>&1; then
        echo "ERROR: required command '$1' was not found."
        exit 1
    fi
}

require_environment() {
    if [ ! -f "${ENV_FILE}" ]; then
        echo "ERROR: ${ENV_FILE} was not found."
        echo "Create it from env.lambda.example."
        exit 1
    fi
}

get_account_id() {
    aws sts get-caller-identity \
        --query Account \
        --output text
}

get_role_arn() {
    aws iam get-role \
        --role-name "${ROLE_NAME}" \
        --query 'Role.Arn' \
        --output text
}

# ------------------------------------------------------------
# Check
# ------------------------------------------------------------

step_check() {
    echo "==> Checking deployment prerequisites..."

    require_command aws
    require_command node
    require_command npm
    require_command npx

    require_environment

    echo
    echo "AWS account:"
    aws sts get-caller-identity

    echo
    echo "Region: ${REGION}"
    echo

    echo "Prerequisites OK."
}

# ------------------------------------------------------------
# Bundle
# ------------------------------------------------------------

step_bundle() {
    echo "==> Building Lambda bundle..."

    rm -rf "${BUILD_DIR}"
    rm -f "${ZIP_FILE}"

    mkdir -p "${BUILD_DIR}"

    npx esbuild src/lambda/handler.ts \
        --bundle \
        --platform=node \
        --target=node20 \
        --format=esm \
        --outfile="${BUILD_DIR}/handler.mjs" \
        --external:dotenv \
        --external:pg-native

    echo "==> Copying runtime dependency: dotenv..."

    mkdir -p "${PACKAGE_DIR}/node_modules"

    cp -R node_modules/dotenv \
        "${PACKAGE_DIR}/node_modules/dotenv"

    echo "==> Creating Lambda package..."

    cp "${BUILD_DIR}/handler.mjs" "${PACKAGE_DIR}/handler.mjs"

    cat > "${PACKAGE_DIR}/package.json" <<'EOF'
{
  "type": "module"
}
EOF

    echo "==> Creating ZIP..."

    if command -v zip >/dev/null 2>&1; then
        (
            cd "${PACKAGE_DIR}"
            zip -qr "../../${ZIP_FILE}" .
        )
    else
        echo "zip command not found; using PowerShell Compress-Archive..."

        powershell.exe -NoProfile -Command \
            "Compress-Archive -Path '${PACKAGE_DIR}/*' -DestinationPath '${ZIP_FILE}' -Force"
    fi

    echo
    echo "Lambda package created:"
    echo "${ZIP_FILE}"
}

# ------------------------------------------------------------
# IAM
# ------------------------------------------------------------

step_role() {
    echo "==> Creating/checking IAM role..."

    if aws iam get-role \
        --role-name "${ROLE_NAME}" \
        >/dev/null 2>&1
    then
        echo "IAM role already exists."
    else
        aws iam create-role \
            --role-name "${ROLE_NAME}" \
            --assume-role-policy-document \
            file://deploy/iam/trust-policy.json

        aws iam put-role-policy \
            --role-name "${ROLE_NAME}" \
            --policy-name "${ROLE_NAME}-logs" \
            --policy-document \
            file://deploy/iam/permissions-policy.json

        echo "Waiting for IAM propagation..."
        sleep 10
    fi

    echo
    echo "Role ARN:"
    get_role_arn
}

# ------------------------------------------------------------
# Lambda
# ------------------------------------------------------------

step_function() {
    if [ ! -f "${ZIP_FILE}" ]; then
        echo "ERROR: ${ZIP_FILE} does not exist."
        echo "Run: ./scripts/deploy-lambda.sh bundle"
        exit 1
    fi

    ROLE_ARN="$(get_role_arn)"

    if aws lambda get-function \
        --function-name "${FUNCTION_NAME}" \
        --region "${REGION}" \
        >/dev/null 2>&1
    then
        echo "==> Lambda exists. Updating code..."

        aws lambda update-function-code \
            --function-name "${FUNCTION_NAME}" \
            --zip-file "fileb://${ZIP_FILE}" \
            --region "${REGION}" \
            >/dev/null

    else
        echo "==> Creating Lambda..."

        aws lambda create-function \
            --function-name "${FUNCTION_NAME}" \
            --runtime "${RUNTIME}" \
            --role "${ROLE_ARN}" \
            --handler "${HANDLER}" \
            --zip-file "fileb://${ZIP_FILE}" \
            --timeout "${TIMEOUT}" \
            --memory-size "${MEMORY_SIZE}" \
            --region "${REGION}" \
            >/dev/null
    fi

    echo "Lambda deployment complete."
}

# ------------------------------------------------------------
# Environment variables
# ------------------------------------------------------------

step_env() {
    require_environment

    echo "==> Loading Lambda environment variables..."

    DATABASE_URL="$(grep '^DATABASE_URL=' "${ENV_FILE}" | cut -d= -f2-)"
    PLAID_CLIENT_ID="$(grep '^PLAID_CLIENT_ID=' "${ENV_FILE}" | cut -d= -f2-)"
    PLAID_SANDBOX_SECRET="$(grep '^PLAID_SANDBOX_SECRET=' "${ENV_FILE}" | cut -d= -f2-)"
    PLAID_SANDBOX_ACCESS_TOKEN="$(grep '^PLAID_SANDBOX_ACCESS_TOKEN=' "${ENV_FILE}" | cut -d= -f2-)"

    if [ -z "${DATABASE_URL}" ]; then
        echo "ERROR: DATABASE_URL is empty."
        exit 1
    fi

    if [ -z "${PLAID_CLIENT_ID}" ]; then
        echo "ERROR: PLAID_CLIENT_ID is empty."
        exit 1
    fi

    if [ -z "${PLAID_SANDBOX_SECRET}" ]; then
        echo "ERROR: PLAID_SANDBOX_SECRET is empty."
        exit 1
    fi

    if [ -z "${PLAID_SANDBOX_ACCESS_TOKEN}" ]; then
        echo "ERROR: PLAID_SANDBOX_ACCESS_TOKEN is empty."
        exit 1
    fi

    aws lambda update-function-configuration \
        --function-name "${FUNCTION_NAME}" \
        --region "${REGION}" \
        --environment "Variables={
DATABASE_URL=${DATABASE_URL},
PLAID_CLIENT_ID=${PLAID_CLIENT_ID},
PLAID_SANDBOX_SECRET=${PLAID_SANDBOX_SECRET},
PLAID_SANDBOX_ACCESS_TOKEN=${PLAID_SANDBOX_ACCESS_TOKEN}
}" \
        >/dev/null

    echo "Lambda environment updated."
}

# ------------------------------------------------------------
# EventBridge
# ------------------------------------------------------------

step_schedule() {
    ACCOUNT_ID="$(get_account_id)"

    FUNCTION_ARN="arn:aws:lambda:${REGION}:${ACCOUNT_ID}:function:${FUNCTION_NAME}"

    RULE_ARN="$(
        aws events put-rule \
            --name "${RULE_NAME}" \
            --schedule-expression "${SCHEDULE_EXPRESSION}" \
            --state ENABLED \
            --description "Runs Personal Finance Agent heartbeat every 5 minutes" \
            --region "${REGION}" \
            --query RuleArn \
            --output text
    )"

    echo "EventBridge rule:"
    echo "${RULE_ARN}"

    echo "==> Allowing EventBridge to invoke Lambda..."

    aws lambda add-permission \
        --function-name "${FUNCTION_NAME}" \
        --statement-id "EventBridgeInvoke" \
        --action "lambda:InvokeFunction" \
        --principal events.amazonaws.com \
        --source-arn "${RULE_ARN}" \
        --region "${REGION}" \
        >/dev/null 2>&1 || true

    echo "==> Connecting EventBridge to Lambda..."

    aws events put-targets \
        --rule "${RULE_NAME}" \
        --targets "Id=PersonalFinanceAgentLambda,Arn=${FUNCTION_ARN}" \
        --region "${REGION}" \
        >/dev/null

    echo
    echo "EventBridge schedule configured:"
    echo "${SCHEDULE_EXPRESSION}"
}

# ------------------------------------------------------------
# Test
# ------------------------------------------------------------

step_test() {
    RESPONSE_FILE="lambda-response.json"

    echo "==> Invoking Lambda manually..."

    aws lambda invoke \
        --function-name "${FUNCTION_NAME}" \
        --region "${REGION}" \
        --cli-binary-format raw-in-base64-out \
        --payload '{}' \
        "${RESPONSE_FILE}" \
        >/dev/null

    echo
    echo "Lambda response:"
    cat "${RESPONSE_FILE}"
    echo

    rm -f "${RESPONSE_FILE}"

    echo
    echo "CloudWatch logs:"
    echo "aws logs tail /aws/lambda/${FUNCTION_NAME} --since 5m --region ${REGION}"
}

# ------------------------------------------------------------
# Status
# ------------------------------------------------------------

step_status() {
    echo "==> Lambda:"
    aws lambda get-function \
        --function-name "${FUNCTION_NAME}" \
        --region "${REGION}" \
        --query 'Configuration.[FunctionName,State,Runtime,Timeout,MemorySize]' \
        --output table

    echo
    echo "==> EventBridge:"
    aws events describe-rule \
        --name "${RULE_NAME}" \
        --region "${REGION}" \
        --query '[Name,State,ScheduleExpression]' \
        --output table

    echo
    echo "==> EventBridge targets:"
    aws events list-targets-by-rule \
        --rule "${RULE_NAME}" \
        --region "${REGION}" \
        --query 'Targets[].Arn' \
        --output table
}

# ------------------------------------------------------------
# Cleanup
# ------------------------------------------------------------

step_destroy() {
    echo "==> Removing EventBridge target..."

    aws events remove-targets \
        --rule "${RULE_NAME}" \
        --ids "PersonalFinanceAgentLambda" \
        --region "${REGION}" \
        >/dev/null 2>&1 || true

    echo "==> Removing EventBridge rule..."

    aws events delete-rule \
        --name "${RULE_NAME}" \
        --region "${REGION}" \
        >/dev/null 2>&1 || true

    echo "==> Removing Lambda..."

    aws lambda delete-function \
        --function-name "${FUNCTION_NAME}" \
        --region "${REGION}" \
        >/dev/null 2>&1 || true

    echo "==> Removing IAM inline policy..."

    aws iam delete-role-policy \
        --role-name "${ROLE_NAME}" \
        --policy-name "${ROLE_NAME}-logs" \
        >/dev/null 2>&1 || true

    echo "==> Removing IAM role..."

    aws iam delete-role \
        --role-name "${ROLE_NAME}" \
        >/dev/null 2>&1 || true

    echo "AWS Lambda deployment resources removed."
}

# ------------------------------------------------------------
# Main
# ------------------------------------------------------------

case "${1:-}" in
    check)
        step_check
        ;;

    bundle)
        step_bundle
        ;;

    role)
        step_role
        ;;

    function)
        step_function
        ;;

    env)
        step_env
        ;;

    schedule)
        step_schedule
        ;;

    test)
        step_test
        ;;

    status)
        step_status
        ;;

    deploy)
        step_check
        step_bundle
        step_role
        step_function
        step_env
        step_schedule
        step_test
        ;;

    destroy)
        step_destroy
        ;;

    *)
        echo "Usage:"
        echo
        echo "  ./scripts/deploy-lambda.sh check"
        echo "  ./scripts/deploy-lambda.sh bundle"
        echo "  ./scripts/deploy-lambda.sh role"
        echo "  ./scripts/deploy-lambda.sh function"
        echo "  ./scripts/deploy-lambda.sh env"
        echo "  ./scripts/deploy-lambda.sh schedule"
        echo "  ./scripts/deploy-lambda.sh test"
        echo "  ./scripts/deploy-lambda.sh status"
        echo "  ./scripts/deploy-lambda.sh deploy"
        echo "  ./scripts/deploy-lambda.sh destroy"
        exit 1
        ;;
esac