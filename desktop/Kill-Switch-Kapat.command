#!/bin/bash
# Tor IP kill switch kurallarini kaldirir. Internet kesik kaldiysa Terminal'den: bash Kill-Switch-Kapat.command
echo "Yonetici sifresi istenebilir."
sudo /sbin/pfctl -a com.apple/torip -F all
echo "Tamam. Internet normale donmeli."
