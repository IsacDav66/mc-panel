#!/bin/bash
# Wrapper que permite enviar comandos al bedrock_server desde el panel web.
# Crea un FIFO (tubería con nombre) y lo mantiene abierto para que el proceso
# nunca reciba un EOF en su entrada estándar.

cd "$(dirname "$0")"
export LD_LIBRARY_PATH=.

FIFO="console.fifo"
if [ ! -p "$FIFO" ]; then
  mkfifo "$FIFO"
fi

# Abrir el FIFO en modo lectura-escritura (fd 3) evita que se cierre
# cuando no hay ningún escritor activo — así el servidor no se detiene
# esperando entrada.
exec 3<>"$FIFO"

exec ./bedrock_server <&3
