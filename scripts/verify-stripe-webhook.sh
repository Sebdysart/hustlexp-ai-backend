#!/bin/bash
# Stripe Webhook Verification Script
# Step 1: Stripe CLI Webhook Replay (Local)

set -e

echo "═══════════════════════════════════════════════════════════════════"
echo "🔍 Stripe Integration Verification - Step 1"
echo "═══════════════════════════════════════════════════════════════════"
echo ""

# Check prerequisites
echo "📋 Checking prerequisites..."
if ! command -v stripe &> /dev/null; then
  echo "❌ Stripe CLI not found. Install: brew install stripe/stripe-cli/stripe"
  exit 1
fi
echo "✅ Stripe CLI installed"

if ! curl -s http://localhost:5000/health > /dev/null 2>&1; then
  echo "❌ Server not running on localhost:5000"
  echo "   Start server: npm run dev"
  exit 1
fi
echo "✅ Server running"

if [ -z "$STRIPE_WEBHOOK_SECRET" ]; then
  echo "⚠️  STRIPE_WEBHOOK_SECRET not set"
  echo "   Get from: stripe listen --print-secret"
fi

echo ""
echo "🚀 Starting Stripe CLI webhook forwarding..."
echo "   Forwarding to: http://localhost:5000/webhooks/stripe"
echo ""
echo "📝 In another terminal, run:"
echo "   stripe trigger customer.subscription.created"
echo "   stripe trigger customer.subscription.updated"
echo ""
echo "Then replay the same event:"
echo "   stripe events resend <event_id>"
echo ""
echo "Press Ctrl+C to stop forwarding"
echo ""

stripe listen --forward-to http://localhost:5000/webhooks/stripe
