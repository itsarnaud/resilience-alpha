@echo off
REM Attaque brute-force courte sur le labo RESILIENCE-ALPHA.
REM Equivalent Windows de : python lab.py --direct --ip <IP> --attempts <NB> --email <EMAIL>
REM
REM Usage : brute-force-spam.cmd [IP_SOURCE] [NB_TENTATIVES] [EMAIL]
REM   IP_SOURCE      par defaut 203.0.113.66 (documentation IP, non routable)
REM   NB_TENTATIVES  par defaut 6 (le detecteur declenche a 5 echecs sur 120 s)
REM   EMAIL          par defaut victim@resilience.local
REM
REM Les requetes partent sur le port 3010 (service auth direct, hors WAF) : c'est
REM le seul chemin ou l'IP source injectee dans X-Forwarded-For est retenue par
REM le service auth. Via le WAF (port 80), l'adresse reelle du client est ajoutee
REM en fin de X-Forwarded-For et c'est elle qui compte.
REM
REM Verification sur le PC Hote :
REM   docker exec db-auth psql -U auth_user -d auth -c "select ip,count(*) from login_attempts where created_at > now() - interval '3 minutes' group by ip;"

setlocal

set "IP=%~1"
if "%IP%"=="" set "IP=203.0.113.66"

set "NB=%~2"
if "%NB%"=="" set "NB=6"

set "EMAIL=%~3"
if "%EMAIL%"=="" set "EMAIL=victim@resilience.local"

echo [*] %NB% tentatives depuis %IP% vers %EMAIL% (port 3010, hors WAF)

for /L %%i in (1,1,%NB%) do (
    curl -s -o nul -X POST http://localhost:3010/v1/login ^
        -H "Content-Type: application/json" ^
        -H "X-Forwarded-For: %IP%" ^
        -d "{\"email\":\"%EMAIL%\",\"password\":\"mauvais\"}"
)

echo [*] Termine. Verification sur le PC Hote :
echo     docker exec db-auth psql -U auth_user -d auth -c "select ip,count(*) from login_attempts where created_at > now() - interval '3 minutes' group by ip;"

endlocal
