#!/usr/bin/env bash
# =============================================================================
# install.sh — 项目管理系统一键部署脚本
#
# 功能：一条命令从零部署（自动检测依赖 → 生成 .env → 启动 PostgreSQL+应用 → 迁移）
#   - 自动检测 docker / docker compose 并校验 daemon 运行状态
#   - 自动生成 .env（基于 .env.example，注入强随机密钥，每个变量带注释）
#   - docker compose 启动 postgres + app + im + 反向代理
#   - 可选 HTTPS（--https，Caddy 自动签发 Let's Encrypt 证书）
#   - 幂等可重复执行（已存在的 .env 不覆盖；up -d / migrate 天然幂等）
#   - 每步日志清晰，失败即停并给出排查方向
#
# 用法：
#   ./deploy/install.sh                 # HTTP 模式（交互询问站点地址）
#   ./deploy/install.sh --https         # HTTPS 模式（Caddy 自动证书，需 --domain）
#   ./deploy/install.sh --domain pm.example.com --https
#   ./deploy/install.sh --non-interactive   # 全自动（默认 http://localhost）
#   ./deploy/install.sh --no-build      # 跳过重新构建镜像（重复部署加速）
#
# 依赖：bash、docker、docker compose（v2 插件或 docker-compose）、openssl（或 /dev/urandom）
# =============================================================================
set -euo pipefail

# ---------- 定位仓库根目录 ----------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${REPO_ROOT}"

COMPOSE_FILE="docker-compose.prod.yml"
ENV_FILE=".env"
ENV_EXAMPLE=".env.example"

# ---------- 选项默认值 ----------
HTTPS_MODE=0
NON_INTERACTIVE=0
DO_BUILD=1
APP_URL=""
DOMAIN=""

# ---------- 颜色（仅在 TTY 下启用） ----------
if [ -t 1 ]; then
  C_BOLD=$'\033[1m'; C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'
  C_RED=$'\033[31m'; C_CYAN=$'\033[36m'; C_RESET=$'\033[0m'
else
  C_BOLD=''; C_GREEN=''; C_YELLOW=''; C_RED=''; C_CYAN=''; C_RESET=''
fi

# ---------- 日志 ----------
info() { printf '%s[install]%s %s\n' "${C_CYAN}" "${C_RESET}" "$*"; }
step() { printf '\n%s==> %s%s\n' "${C_BOLD}" "$*" "${C_RESET}"; }
ok()   { printf '%s  ✓ %s%s\n' "${C_GREEN}" "$*" "${C_RESET}"; }
warn() { printf '%s  ! %s%s\n' "${C_YELLOW}" "$*" "${C_RESET}"; }
die()  { printf '%s  ✗ %s%s\n' "${C_RED}" "$*" "${C_RESET}" >&2; exit 1; }

# ---------- 用法 ----------
usage() {
  cat <<'EOF'
用法: ./deploy/install.sh [选项]

选项:
  --https                  启用 HTTPS（Caddy 自动签发 Let's Encrypt 证书）
  --domain <域名>          站点域名（HTTPS 模式必填），如 pm.example.com
  --url <地址>             站点访问地址（HTTP 模式），如 http://1.2.3.4:8080
  -y, --yes, --non-interactive  非交互模式（不询问，使用默认/参数值）
  --no-build               跳过镜像重建（重复部署加速）
  -h, --help               显示本帮助

示例:
  ./deploy/install.sh                               # HTTP，交互询问站点地址
  ./deploy/install.sh --https --domain pm.example.com   # HTTPS 自动证书
  ./deploy/install.sh --non-interactive             # 全自动，默认 http://localhost
EOF
}

# ---------- 解析参数 ----------
parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --https|--ssl)            HTTPS_MODE=1 ;;
      --domain)                 DOMAIN="${2:-}"; shift ;;
      --domain=*)               DOMAIN="${1#*=}" ;;
      --url)                    APP_URL="${2:-}"; shift ;;
      --url=*)                  APP_URL="${1#*=}" ;;
      -y|--yes|--non-interactive) NON_INTERACTIVE=1 ;;
      --no-build)               DO_BUILD=0 ;;
      -h|--help)                usage; exit 0 ;;
      *)                        die "未知参数: $1（用 --help 查看用法）" ;;
    esac
    shift
  done
}

# ---------- 生成强随机密钥 ----------
gen_secret() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  elif command -v od >/dev/null 2>&1; then
    head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'
  else
    date +%s%N | sha256sum 2>/dev/null | cut -d' ' -f1 || echo "please-set-a-strong-random-secret"
  fi
}

# ---------- 检测依赖 ----------
check_deps() {
  step "1/5 检测依赖 (docker / docker compose)"

  if ! command -v docker >/dev/null 2>&1; then
    die "未检测到 docker。请先安装：https://docs.docker.com/engine/install/ 然后重试。"
  fi
  info "docker: $(docker --version 2>/dev/null || echo unknown)"

  if docker compose version >/dev/null 2>&1; then
    COMPOSE_BIN=(docker compose)
  elif command -v docker-compose >/dev/null 2>&1; then
    COMPOSE_BIN=(docker-compose)
  else
    die "未检测到 Docker Compose。请安装 compose 插件：https://docs.docker.com/compose/install/"
  fi
  info "compose: ${COMPOSE_BIN[*]} ($("${COMPOSE_BIN[@]}" version --short 2>/dev/null || echo unknown))"

  if ! docker info >/dev/null 2>&1; then
    die "Docker daemon 未运行或当前用户无权限。排查：sudo systemctl start docker；或把当前用户加入 docker 组后重新登录（sudo usermod -aG docker \$USER）。"
  fi
  ok "依赖检测通过"
}

# ---------- compose 调用封装（统一 -f 指定生产编排文件） ----------
compose() {
  "${COMPOSE_BIN[@]}" -f "${COMPOSE_FILE}" "$@"
}

# ---------- 用 awk 安全地写入/替换 .env 中 KEY= 的值 ----------
set_env() {
  local key="$1" val="$2" tmp
  tmp="$(mktemp)"
  awk -v k="$key" -v v="$val" '
    index($0, k"=") == 1 { print k"="v; next }
    { print }
  ' "${ENV_FILE}" > "${tmp}"
  mv "${tmp}" "${ENV_FILE}"
}

# ---------- 准备环境变量 ----------
ensure_env() {
  local db_pass jwt sec tmp
  step "2/5 准备环境变量 (.env)"

  if [ -f "${ENV_FILE}" ]; then
    info ".env 已存在，跳过生成（幂等：不会覆盖你的既有配置）"
  else
    if [ ! -f "${ENV_EXAMPLE}" ]; then
      die "缺少模板 ${ENV_EXAMPLE}，无法生成 .env。"
    fi
    cp "${ENV_EXAMPLE}" "${ENV_FILE}"
    info "已从 ${ENV_EXAMPLE} 复制模板"

    # 交互：站点地址
    if [ -z "${APP_URL}" ] && [ "${NON_INTERACTIVE}" -eq 0 ]; then
      printf '%s站点访问地址（http(s)://域名 或 http://IP:端口，末尾不带斜杠）[http://localhost]: %s' "${C_BOLD}" "${C_RESET}"
      read -r APP_URL || APP_URL=""
    fi
    APP_URL="${APP_URL:-http://localhost}"

    # 交互：HTTPS 域名
    if [ "${HTTPS_MODE}" -eq 1 ]; then
      if [ -z "${DOMAIN}" ] && [ "${NON_INTERACTIVE}" -eq 0 ]; then
        printf '%sHTTPS 域名（Caddy 自动签发证书，如 pm.example.com）: %s' "${C_BOLD}" "${C_RESET}"
        read -r DOMAIN || DOMAIN=""
      fi
      if [ -z "${DOMAIN}" ]; then
        die "HTTPS 模式需要域名（用 --domain 指定或交互输入）。Caddy 必须用真实域名才能签发证书。"
      fi
    fi

    # 写入站点地址 / 域名
    set_env "APP_URL" "${APP_URL}"
    set_env "DOMAIN" "${DOMAIN:-}"

    # 展开前端地址变量（避免依赖 compose 嵌套插值）：
    # NEXT_PUBLIC_WS_URL 指向 origin 根，不要带 /socket.io 路径
    set_env "NEXT_PUBLIC_APP_URL" "${APP_URL}"
    set_env "NEXT_PUBLIC_API_URL" "${APP_URL}"
    set_env "NEXT_PUBLIC_WS_URL" "${APP_URL}"

    # 为每个 __AUTO_GENERATE__ 注入独立随机密钥（awk 逐次替换首个，跨平台稳妥）
    while grep -q '__AUTO_GENERATE__' "${ENV_FILE}"; do
      sec="$(gen_secret)"
      tmp="$(mktemp)"
      awk -v s="${sec}" '!done && index($0, "__AUTO_GENERATE__") { sub(/__AUTO_GENERATE__/, s); done=1 } { print }' "${ENV_FILE}" > "${tmp}"
      mv "${tmp}" "${ENV_FILE}"
    done

    # 兜底清理残留占位符
    sed -i.bak 's/__ASK__//g; s/__AUTO_GENERATE__//g' "${ENV_FILE}"
    rm -f "${ENV_FILE}.bak"

    ok ".env 已生成（含强随机 DB_PASSWORD / JWT_SECRET 等）"
  fi

  # 校验必填项
  db_pass="$(grep -E '^DB_PASSWORD=' "${ENV_FILE}" | head -1 | cut -d= -f2- || true)"
  jwt="$(grep -E '^JWT_SECRET=' "${ENV_FILE}" | head -1 | cut -d= -f2- || true)"
  if [ -z "${db_pass}" ] || [ "${db_pass}" = "__AUTO_GENERATE__" ] || [ "${db_pass}" = "CHANGE_ME_STRONG_PASSWORD" ]; then
    die ".env 中 DB_PASSWORD 为空或仍为占位符。请设置强密码（openssl rand -hex 32）。"
  fi
  if [ -z "${jwt}" ] || [ "${jwt}" = "__AUTO_GENERATE__" ]; then
    die ".env 中 JWT_SECRET 为空或仍为占位符。请设置（openssl rand -hex 32）。"
  fi
  ok "必填变量校验通过（DB_PASSWORD / JWT_SECRET 已就绪）"
}

# ---------- 准备目录 ----------
prepare_dirs() {
  step "3/5 准备目录"
  mkdir -p deploy/certs downloads
  ok "目录就绪（deploy/certs 证书目录、downloads APK 分发目录）"
}

# ---------- 校验 compose 配置 ----------
validate_compose() {
  step "4/5 校验并启动容器"
  if ! compose config -q; then
    die "compose 配置校验失败。排查：检查 ${ENV_FILE} 变量是否完整；运行 ${COMPOSE_BIN[*]} -f ${COMPOSE_FILE} config 查看详细报错。"
  fi
  ok "compose 配置校验通过"

  local profile="http"
  [ "${HTTPS_MODE}" -eq 1 ] && profile="https"
  local build_flag=""
  [ "${DO_BUILD}" -eq 1 ] && build_flag="--build"

  info "profile=${profile} build=$([ -n "${build_flag}" ] && echo on || echo off)"
  if ! compose --profile "${profile}" up -d ${build_flag}; then
    die "容器启动失败。排查：${COMPOSE_BIN[*]} -f ${COMPOSE_FILE} --profile ${profile} up -d 看报错；端口被占用用 ss -tlnp 查；镜像构建失败看上方 build 日志。"
  fi
  ok "容器已启动（${profile} 模式）"
}

# ---------- 数据库迁移 ----------
run_migration() {
  step "5/5 数据库迁移 (prisma migrate deploy)"

  # 等待 app 容器可执行
  local i
  for i in $(seq 1 60); do
    if docker exec pm-app true >/dev/null 2>&1; then
      break
    fi
    [ "${i}" -eq 60 ] && die "app 容器迟迟未就绪。排查：${COMPOSE_BIN[*]} -f ${COMPOSE_FILE} logs app 查看启动日志。"
    sleep 2
  done

  info "执行 prisma migrate deploy（幂等，已应用过的迁移会自动跳过）…"
  if ! compose exec -T app npx --no-install prisma migrate deploy; then
    die "数据库迁移失败。排查：${COMPOSE_BIN[*]} -f ${COMPOSE_FILE} logs postgres 确认已 healthy；核对 DATABASE_URL；${COMPOSE_BIN[*]} -f ${COMPOSE_FILE} exec app npx prisma migrate status 查看迁移状态。"
  fi
  ok "迁移完成"

  # 重启 im，使其从首次启动的 memory 回退切换到 prisma 持久化（表已建好）
  info "重启 im 服务以启用 prisma 持久化存储…"
  compose restart im >/dev/null
  ok "im 服务已重启"
}

# ---------- 完成提示 ----------
print_summary() {
  local url="${APP_URL:-http://localhost}"
  # 若 .env 已存在且本次未设 APP_URL，则从 .env 读取展示
  if [ -z "${APP_URL}" ]; then
    url="$(grep -E '^APP_URL=' "${ENV_FILE}" | head -1 | cut -d= -f2- || echo 'http://localhost')"
  fi
  if [ "${HTTPS_MODE}" -eq 1 ] && [ -n "${DOMAIN}" ]; then
    url="https://${DOMAIN}"
  fi

  printf '\n%s%s部署完成 ✓%s\n' "${C_BOLD}" "${C_GREEN}" "${C_RESET}"
  printf '%s  访问地址: %s%s\n' "${C_BOLD}" "${url}" "${C_RESET}"
  printf '%s  状态查看: %s%s\n' "${C_BOLD}" "${COMPOSE_BIN[*]} -f ${COMPOSE_FILE} ps${C_RESET}"
  printf '%s  日志查看: %s%s\n' "${C_BOLD}" "${COMPOSE_BIN[*]} -f ${COMPOSE_FILE} logs -f${C_RESET}"
  printf '%s  停止服务: %s%s\n' "${C_BOLD}" "${COMPOSE_BIN[*]} -f ${COMPOSE_FILE} down${C_RESET}"
  printf '%s  详见文档: docs/deployment.md%s\n' "${C_BOLD}" "${C_RESET}"
  printf '\n%s首次使用：注册管理员账号后即可登录；或运行种子脚本导入演示数据。%s\n' "${C_YELLOW}" "${C_RESET}"
}

# ---------- 主流程 ----------
main() {
  parse_args "$@"

  printf '%s\n' "${C_BOLD}项目管理系统 · 一键部署${C_RESET}"
  info "仓库目录: ${REPO_ROOT}"
  info "编排文件: ${COMPOSE_FILE}"

  check_deps
  ensure_env
  prepare_dirs
  validate_compose
  run_migration
  print_summary
}

main "$@"
