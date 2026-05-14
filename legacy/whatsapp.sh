#!/usr/bin/env bash

PHONE_ID="${WHATSAPP_PHONE_ID:-705265779340810}"
ACCESS_TOKEN="${WHATSAPP_ACCESS_TOKEN:-EAARZCkKzKSeYBPHodJGWi10V6R7LUUlan85tYAnOROBiuhG70rYPZCYWxtwoZAhKtMsRx3XXpZAF3ktkRrtknSwZBE7CSj0WalP8rRoXZA2KRQozHlpKmeEdbVaZB77Ar0i7cXrpSQzv1vRzKJrayipTz2Ien2DZBwloo33L728ggFo5UhVuZB4QSHPX7I2Pl0L0JlgEs7VBXBBCKQCqAPZC6fgqigqraC4ZAbF5HrulPpjTVTtKgZDZD}"
RECIPIENT="${WHATSAPP_RECIPIENT:-+27677427205}"  # Replace <phone number> with default if needed

send_whatsapp() {
    local message="$1"
    # Escape message for JSON (handle quotes, newlines, etc.)
    local escaped_message=$(printf '%s' "$message" | sed 's/["\]/\\&/g')
    
    local payload=$(cat <<EOF
{
  "messaging_product": "whatsapp",
  "recipient_type": "individual",
  "to": "$RECIPIENT",
  "type": "text",
  "text": {
    "preview_url": false,
    "body": "$escaped_message"
  }
}
EOF
)
    
    local response=$(curl -s -X POST \
      "https://graph.facebook.com/v23.0/${PHONE_ID}/messages" \
      -H "Authorization: Bearer ${ACCESS_TOKEN}" \
      -H "Content-Type: application/json" \
      -d "$payload")
    
    if echo "$response" | grep -q '"messages"'; then
        echo "WhatsApp message sent successfully: $message"
    else
        echo "Failed to send WhatsApp message: $response"
    fi
}

if [ $# -eq 0 ]; then
    message="Test on $HOSTNAME at $(date)"
else
    message="$1"
fi

send_whatsapp "$message"
