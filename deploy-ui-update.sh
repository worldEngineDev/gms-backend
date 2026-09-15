#!/bin/bash
# GMS UI 优化部署脚本 (带备份和回滚)
# 使用方法: ./deploy-ui-update.sh [backup|deploy|rollback]

set -e

SERVER="10.5.51.216"
SERVER_USER="root"
REMOTE_PATH="/root/gms-backend"
BACKUP_DIR="/root/gms-backups"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_NAME="gms-ui-backup-${TIMESTAMP}"

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# 1. 备份当前版本
backup_current() {
    log_info "开始备份当前版本到 .216 服务器..."

    ssh ${SERVER_USER}@${SERVER} << 'ENDSSH'
set -e

# 创建备份目录
mkdir -p /root/gms-backups

# 备份时间戳
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_NAME="gms-ui-backup-${TIMESTAMP}"

# 创建备份
cd /root
tar -czf gms-backups/${BACKUP_NAME}.tar.gz \
    gms-backend/web/src/common/styles/global.css \
    gms-backend/web/src/common/styles/redesign.css \
    gms-backend/web/src/common/components/AppProviders.tsx \
    gms-backend/web/src/common/components/PageContainer.tsx \
    gms-backend/web/src/maintenance/layout/AppLayout.tsx \
    gms-backend/web/src/operations/layout/OpsLayout.tsx \
    gms-backend/web/src/maintenance/layout/LoginScreen.tsx \
    gms-backend/web/src/maintenance/main.tsx \
    gms-backend/web/src/operations/main.tsx \
    gms-backend/css/mobile.css \
    gms-backend/css/status-pages.css \
    gms-backend/mobile.html \
    gms-backend/mobile-ops.html \
    gms-backend/sn-status.html \
    gms-backend/machine-status.html \
    gms-backend/location-status.html \
    gms-backend/delivery-note.html \
    gms-backend/web/dist/ \
    gms-backend/index.html \
    gms-backend/operations.html \
    2>/dev/null || true

# 记录备份信息
echo "${TIMESTAMP}|${BACKUP_NAME}" >> gms-backups/backup-history.log

# 保留最近 10 个备份
cd gms-backups
ls -t gms-ui-backup-*.tar.gz | tail -n +11 | xargs -r rm

echo "备份完成: ${BACKUP_NAME}.tar.gz"
ls -lh gms-ui-backup-*.tar.gz | tail -5
ENDSSH

    if [ $? -eq 0 ]; then
        log_info "✅ 备份成功: ${BACKUP_NAME}.tar.gz"
    else
        log_error "❌ 备份失败"
        exit 1
    fi
}

# 2. 部署新版本
deploy_new_version() {
    log_info "开始部署 UI 优化更新..."

    # 先备份
    backup_current

    log_info "构建前端项目..."
    cd gms-backend/web

    # 检查 node_modules
    if [ ! -d "node_modules" ]; then
        log_warn "node_modules 不存在，正在安装依赖..."
        npm install
    fi

    # 构建
    npm run build

    if [ $? -ne 0 ]; then
        log_error "❌ 构建失败"
        exit 1
    fi

    log_info "✅ 构建成功"

    # 上传更新的文件到服务器
    log_info "上传文件到 .216 服务器..."

    # 上传独立新版样式（旧 global.css 保留，便于随时恢复）
    scp src/common/styles/redesign.css \
        ${SERVER_USER}@${SERVER}:${REMOTE_PATH}/web/src/common/styles/redesign.css

    # 上传构建后的 dist 目录
    rsync -avz --delete dist/ \
        ${SERVER_USER}@${SERVER}:${REMOTE_PATH}/web/dist/

    log_info "✅ 文件上传完成"

    # 在服务器上重启服务
    log_info "重启服务..."
    ssh ${SERVER_USER}@${SERVER} << 'ENDSSH'
cd /root/gms-backend
pm2 restart gms-backend || pm2 start ecosystem.config.js
pm2 status
ENDSSH

    if [ $? -eq 0 ]; then
        log_info "✅ 部署成功！"
        log_info "访问 http://10.5.51.216:8765 查看效果"
        log_info "备份文件: ${BACKUP_NAME}.tar.gz"
    else
        log_error "❌ 服务重启失败"
        exit 1
    fi
}

# 3. 回滚到指定备份
rollback() {
    log_warn "开始回滚操作..."

    # 列出可用备份
    ssh ${SERVER_USER}@${SERVER} << 'ENDSSH'
echo "可用的备份版本:"
cd /root/gms-backups
ls -lht gms-ui-backup-*.tar.gz | head -10
ENDSSH

    # 让用户选择备份版本
    echo ""
    read -p "请输入要回滚的备份文件名 (例如: gms-ui-backup-20260903_143000.tar.gz): " BACKUP_FILE

    if [ -z "$BACKUP_FILE" ]; then
        log_error "未指定备份文件"
        exit 1
    fi

    log_info "回滚到: ${BACKUP_FILE}"

    ssh ${SERVER_USER}@${SERVER} << ENDSSH
set -e
cd /root/gms-backups

if [ ! -f "${BACKUP_FILE}" ]; then
    echo "错误: 备份文件不存在"
    exit 1
fi

# 解压备份
tar -xzf ${BACKUP_FILE} -C /root/

echo "✅ 回滚完成"

# 重启服务
cd /root/gms-backend
pm2 restart gms-backend || pm2 start ecosystem.config.js
ENDSSH

    if [ $? -eq 0 ]; then
        log_info "✅ 回滚成功！"
    else
        log_error "❌ 回滚失败"
        exit 1
    fi
}

# 4. 查看备份历史
list_backups() {
    log_info "查询备份历史..."
    ssh ${SERVER_USER}@${SERVER} << 'ENDSSH'
echo "=== 备份历史 ==="
cd /root/gms-backups
if [ -f backup-history.log ]; then
    echo ""
    echo "最近 10 次备份:"
    tail -10 backup-history.log
    echo ""
fi

echo "=== 备份文件 ==="
ls -lht gms-ui-backup-*.tar.gz 2>/dev/null | head -10 || echo "暂无备份"
ENDSSH
}

# 主函数
main() {
    case "${1:-}" in
        backup)
            backup_current
            ;;
        deploy)
            deploy_new_version
            ;;
        rollback)
            rollback
            ;;
        list)
            list_backups
            ;;
        *)
            echo "GMS UI 优化部署脚本"
            echo ""
            echo "使用方法:"
            echo "  $0 backup    - 仅备份当前版本"
            echo "  $0 deploy    - 部署新版本 (自动备份)"
            echo "  $0 rollback  - 回滚到指定备份"
            echo "  $0 list      - 查看备份历史"
            echo ""
            echo "快速部署: $0 deploy"
            exit 1
            ;;
    esac
}

main "$@"
