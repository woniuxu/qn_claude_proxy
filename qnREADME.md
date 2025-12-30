edit js
docker build -t qn_claude_proxy:2.0 .
docker tag qn_claud_proxy:2.0  10.170.100.179:5000/qn_claude_proxy:1.0
docker push 10.170.100.179:5000/qn_claude_proxy:2.0

on 166
docker pull localhost:5000/qn_claude_proxy:2.0


<!-- 1. vim .dev.vars and set OPENAI_BASE_URL="http://localhost/v1"
2. npx wrangler dev
3. enjoy -->
