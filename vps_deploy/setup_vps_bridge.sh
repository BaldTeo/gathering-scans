#!/usr/bin/env bash
# ==============================================================================
# GatheringScans — Hostinger Linux VPS (76.13.197.29) Bridge Setup Script
# ==============================================================================
# Configures:
# 1. SSH authorized_keys for the Windows PC Reverse Tunnel (18095 -> 8095)
# 2. SSHD GatewayPorts / AllowTcpForwarding for loopback/docker reverse proxy
# 3. Caddy reverse proxy block for https://scans.gatheren.cloud
#
# STRICT DISK POLICY: Zero scan data, photos, or caches are stored on this VPS.
# ==============================================================================
set -euo pipefail

PC_SSH_PUBKEY="ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI" # Replaced automatically by deploy script or ~/.ssh/id_gathering_vps.pub

mkdir -p ~/.ssh
chmod 700 ~/.ssh
touch ~/.ssh/authorized_keys
chmod 600 ~/.ssh/authorized_keys

if [ -f ./id_gathering_vps.pub ]; then
    PUBKEY_CONTENT=$(cat ./id_gathering_vps.pub)
    if ! grep -qF "$PUBKEY_CONTENT" ~/.ssh/authorized_keys; then
        echo "$PUBKEY_CONTENT" >> ~/.ssh/authorized_keys
        echo "[GatheringScans VPS] Added Windows PC SSH public key to ~/.ssh/authorized_keys"
    fi
fi

# Ensure sshd allows reverse port forwarding on 18095
sudo sed -i 's/^#*AllowTcpForwarding.*/AllowTcpForwarding yes/' /etc/ssh/sshd_config
sudo sed -i 's/^#*GatewayPorts.*/GatewayPorts clientspecified/' /etc/ssh/sshd_config
sudo systemctl reload sshd || sudo service ssh reload

echo "[GatheringScans VPS] SSH Reverse Tunnel endpoint ready on port 18095 -> Windows PC:8095"
