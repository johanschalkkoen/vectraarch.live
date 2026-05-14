#!/usr/bin/bash
BOT_TOKEN="8145122904:AAHkoHU3GFHqZdabolE_Enyduyaw6ZGmx58"  # Telegram Bot API token
CHAT_ID="-4734083762"                         # Telegram chat ID for notifications

send_telegram() {
    local message="$1"
    curl "https://api.telegram.org/bot$BOT_TOKEN/sendMessage" -d "chat_id=$CHAT_ID&text=$message"
    echo "$message"  # Log message to console
}

send_telegram "Test on $HOSTNAME at $(date)"
