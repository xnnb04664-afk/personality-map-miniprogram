#!/usr/bin/env bash
set -euo pipefail

# 可使用环境变量，也可按顺序传入：INSTALL_PATH ENV_ID PROJECT_PATH
installPath="${INSTALL_PATH:-${1:-}}"
envId="${ENV_ID:-${2:-}}"
projectPath="${PROJECT_PATH:-${3:-$(pwd)}}"

if [[ -z "$installPath" || -z "$envId" ]]; then
  echo "用法: INSTALL_PATH=/path/to/cloudbase ENV_ID=环境ID PROJECT_PATH=项目目录 ./uploadCloudFunction.sh" >&2
  echo "或: ./uploadCloudFunction.sh /path/to/cloudbase 环境ID 项目目录" >&2
  exit 2
fi

"$installPath" cloud functions deploy --e "$envId" --n assessmentApi --r --project "$projectPath"
