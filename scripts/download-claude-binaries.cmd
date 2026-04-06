@echo off                                                                                                                                                            
setlocal                                                                                                                                                             
                                                                                                                                                                       
set "SCRIPT_DIR=%~dp0"                                                                                                                                               
set "PS1=%SCRIPT_DIR%download-claude-binaries.ps1"                                                                                                                   
                                                                                                                                                                     
if not exist "%PS1%" (                                                                                                                                               
    echo [ERROR] 找不到 PowerShell 脚本:                                                                                                                             
    echo         "%PS1%"                                                                                                                                             
    exit /b 1                                                                                                                                                        
)                                                                                                                                                                    
                                                                                                                                                                     
where pwsh >nul 2>nul                                                                                                                                                
if errorlevel 1 (                                                                                                                                                    
    echo [ERROR] 未找到 pwsh ^(PowerShell 7^)，请先安装并加入 PATH。                                                                                                 
    exit /b 1                                                                                                                                                        
)                                                                                                                                                                    
                                                                                                                                                                     
if "%~1"=="" (                                                                                                                                                       
    echo 用法:                                                                                                                                                       
    echo   %~nx0 2.1.89                                                                                                                                              
    echo   %~nx0 2.1.89 -IncludeCompressed                                                                                                                           
    echo   %~nx0 2.1.89 -OutputDir F:\Temp\claude-dist                                                                                                               
    echo   %~nx0 2.1.89 -OutputDir "F:\Temp\claude dist" -IncludeCompressed                                                                                          
    exit /b 1                                                                                                                                                        
)                                                                                                                                                                    
                                                                                                                                                                     
set "VERSION=%~1"                                                                                                                                                    
shift                                                                                                                                                                
                                                                                                                                                                     
pwsh -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%PS1%" -Version "%VERSION%" %*                                                                
set "EXITCODE=%ERRORLEVEL%"                                                                                                                                          
                                                                                                                                                                     
if not "%EXITCODE%"=="0" (                                                                                                                                           
    echo.                                                                                                                                                            
    echo [ERROR] 脚本执行失败，退出码=%EXITCODE%                                                                                                                     
    exit /b %EXITCODE%                                                                                                                                               
)                                                                                                                                                                    
                                                                                                                                                                     
echo.                                                                                                                                                                
echo [OK] 下载完成                                                                                                                                                   
exit /b 0