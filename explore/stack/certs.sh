#!/bin/sh
# One-shot: a private test CA and server certificates for the explore stack, made once into /certs (outside the repo).
# Python 3.13 verifies with VERIFY_X509_STRICT, so the CA and leaves carry the extensions it insists on: basic
# constraints, key usage, subject and authority key identifiers, and subject alternative names.
set -eu
apk add --no-cache openssl >/dev/null

cd /certs
if [ ! -s ca.pem ]; then
    openssl req -x509 -new -nodes -newkey rsa:2048 -sha256 -days 825 -keyout ca-key.pem -out ca.pem \
        -subj "/CN=HermitShell explore test CA" \
        -addext "basicConstraints=critical,CA:TRUE" \
        -addext "keyUsage=critical,keyCertSign,cRLSign" \
        -addext "subjectKeyIdentifier=hash" 2>/dev/null
fi

for name in worker mailpit replay-search; do
    [ -s "$name.pem" ] && continue
    cat > "$name.ext" <<EOF
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=DNS:$name,DNS:localhost,IP:127.0.0.1
subjectKeyIdentifier=hash
authorityKeyIdentifier=keyid,issuer
EOF
    openssl req -new -nodes -newkey rsa:2048 -sha256 -keyout "$name-key.pem" -out "$name.csr" -subj "/CN=$name" 2>/dev/null
    openssl x509 -req -sha256 -days 397 -in "$name.csr" -CA ca.pem -CAkey ca-key.pem -CAcreateserial \
        -out "$name.pem" -extfile "$name.ext" 2>/dev/null
    rm -f "$name.csr" "$name.ext"
done
# The services run as different users; these keys only ever protect this machine's throwaway test stack.
chmod 644 ./*.pem
chmod 600 ca-key.pem

# Volumes start out owned by root: the backend runs as 10000 and the Worker's Node as 1000.
chown -R 10000:10000 /data
chown -R 1000:1000 /state /modules
echo "certs ready"
