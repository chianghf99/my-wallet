@echo off
chcp 65001 >nul
cls

echo ==========================================
echo      🤖 帳單機器人 自動打包工具
echo ==========================================
echo.

:: 1. 清理舊的編譯資料夾 (避免 PermissionError)
echo [1/3] 正在清理舊的暫存檔...
if exist build (
    rmdir /s /q build
    echo  - build 資料夾已刪除
)
if exist dist (
    rmdir /s /q dist
    echo  - dist 資料夾已刪除
)
if exist "*.spec" (
    del /q "*.spec"
    echo  - spec 設定檔已刪除
)

echo.
echo [2/3] 開始執行 PyInstaller 打包...
echo ------------------------------------------

:: 2. 執行打包指令 (您可以隨時來這裡修改參數)
:: --clean: 清理快取
:: --noconfirm: 不詢問直接覆蓋
:: --onefile: 打包成單一檔案
pyinstaller --name="帳單機器人(PC)" --onefile --clean --noconfirm perse_bill.py

echo.
echo ------------------------------------------

:: 3. 檢查結果
if %errorlevel% neq 0 (
    color 4f
    echo.
    echo ❌❌❌ 打包失敗！ ❌❌❌
    echo.
    echo 可能原因：
    echo 1. 檔案被防毒軟體鎖住了 (請暫時關閉即時防護)
    echo 2. perse_bill.py 程式碼有語法錯誤
    echo.
) else (
    color 2f
    echo.
    echo ✅✅✅ 打包成功！ ✅✅✅
    echo.
    echo 請到 dist 資料夾領取您的 [帳單機器人(PC).exe]
    echo 記得把它跟 config.json 放在一起喔！
    echo.
)

pause