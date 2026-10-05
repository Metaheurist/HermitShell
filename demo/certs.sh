#!/bin/sh
# The demo container's private CA and one server certificate (localhost, 127.0.0.1) for the Worker, Mailpit and the
# replay servers, made on first start into the given folder. The CA's key never leaves the container's /data.
# Python 3.13 verifies with VERIFY_X509_STRICT, so both carry the extensions it insists on.
set -eu
dir="$1"
mkdir -p "$dir"
cd "$dir"
umask 077
if [ ! -s ca.pem ]; then
    openssl req -x509 -new -nodes -newkey rsa:2048 -sha256 -days 825 -keyout ca-key.pem -out ca.pem \
        -subj "/CN=HermitShell demo CA" \
        -addext "basicConstraints=critical,CA:TRUE" \
        -addext "keyUsage=critical,keyCertSign,cRLSign" \
        -addext "subjectKeyIdentifier=hash" 2>/dev/null
fi
if [ ! -s server.pem ]; then
    cat > server.ext <<EOF
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=DNS:localhost,IP:127.0.0.1
subjectKeyIdentifier=hash
authorityKeyIdentifier=keyid,issuer
EOF
    openssl req -new -nodes -newkey rsa:2048 -sha256 -keyout server-key.pem -out server.csr -subj "/CN=localhost" 2>/dev/null
    openssl x509 -req -sha256 -days 397 -in server.csr -CA ca.pem -CAkey ca-key.pem -CAcreateserial \
        -out server.pem -extfile server.ext 2>/dev/null
    rm -f server.csr server.ext
fi
cat "$(python3 -m certifi)" ca.pem > bundle.pem
chmod 644 ca.pem server.pem bundle.pem
