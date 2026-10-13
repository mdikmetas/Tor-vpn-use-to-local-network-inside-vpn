@echo off
rem Tor IP kill switch kurallarini kaldirir. Internet kesik kaldiysa: bu dosyaya SAG TIK > "Yonetici olarak calistir".
net session >nul 2>&1
if %errorlevel% neq 0 (
  echo Yonetici olarak calistirmalisin: dosyaya sag tik, "Yonetici olarak calistir".
  pause
  exit /b 1
)
netsh advfirewall firewall delete rule name=TorIP-KS-v4
netsh advfirewall firewall delete rule name=TorIP-KS-v6
echo Tamam. Internet normale donmeli.
pause
