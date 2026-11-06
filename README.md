# CraftPanel

Gestor de escritorio para crear y administrar servidores de Minecraft **Java** (Paper, Vanilla y Fabric) y **Bedrock oficial** desde una interfaz sencilla en español.

## Funciones

- **Crear servidores** con descarga automática de la versión elegida.
- **Consola en vivo** con historial, autocompletado y envío de comandos.
- **Iniciar, detener y forzar cierre** de cada servidor.
- **Editor de `server.properties`** con formulario y editor de texto.
- **Copias de seguridad** en ZIP, restauración y limpieza automática.
- **Lista de jugadores** conectados en tiempo real.
- **Acceso para amigos**:
  - Apertura automática de puertos con **UPnP** (TCP y UDP).
  - Instrucciones para abrir el puerto manualmente en el router.
  - Comprobación del servidor desde Internet con mcsrvstat.us.
  - Túnel de **Cloudflare** (experimental, solo Java/TCP).
- **Ajustes**: memoria RAM, ruta de Java, ruta de cloudflared y carpeta de servidores.

## Requisitos

- Windows 10/11 (también funciona en Linux/macOS con los ajustes adecuados).
- [Node.js](https://nodejs.org/) 20 o superior.
- **Java 21 o superior** para servidores Java. Paper reciente puede pedir Java 25.
  - CraftPanel detecta Java automáticamente y también permite indicar la ruta manualmente en Ajustes.
- Para Bedrock no hace falta Java.
- Opcional: [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) si quieres probar el túnel.

## Instalación y uso

1. Abre una terminal en esta carpeta.
2. Instala las dependencias:

   ```bat
   npm install
   ```

3. Inicia la aplicación:

   ```bat
   npm start
   ```

   También puedes hacer doble clic en **`CraftPanel.bat`**, que instala las dependencias la primera vez y arranca la app.

Para desarrollar con las herramientas de Chromium abiertas:

```bat
npm run dev
```

## Primeros pasos

1. Pulsa **Nuevo servidor**.
2. Elige **Java** o **Bedrock** y el software.
3. Selecciona la versión y asigna un nombre y un puerto.
4. Acepta el EULA de Minecraft y espera a que termine la instalación.
5. Pulsa **Iniciar** y abre la pestaña **Consola** para ver el progreso.
6. En **Red** configura el acceso para tus amigos.

## Acceso desde Internet

### UPnP (recomendado)

En la pestaña **Red**, pulsa **Abrir puerto en el router**. CraftPanel pide al router que redirija el puerto del servidor hacia este PC.

- Java usa **TCP**.
- Bedrock usa **UDP** (y el puerto IPv6 suele ser el siguiente, por ejemplo 19133).

Si el router no responde, la app lo indica y muestra las instrucciones manuales.

### Abrir el puerto a mano

1. Entra en el panel del router (normalmente `192.168.1.1`).
2. Busca la sección **Port Forwarding / Redirección de puertos**.
3. Redirige el puerto del servidor a la IP local de este PC.
4. Permite Minecraft o el puerto correspondiente en el Firewall de Windows.

> Si tu operador usa **CGNAT**, la IP pública no será realmente tuya y el puerto no funcionará aunque lo abras. En ese caso necesitarías un túnel o pedir una IP pública al operador.

### Túnel de Cloudflare (experimental)

Los túneles rápidos gratuitos de Cloudflare están pensados para HTTP. Para Minecraft funcionan de forma limitada:

- Solo para **Java/TCP**.
- Tus amigos deben instalar `cloudflared` y ejecutar el comando que muestra la app.
- Después se conectan a `127.0.0.1`.

No se puede usar con **Bedrock**, porque Bedrock usa UDP.

## Copias de seguridad

Las copias se guardan en la carpeta `backups` dentro de cada servidor. Detén el servidor antes de crear o restaurar una copia para que el mundo quede consistente. CraftPanel crea una copia de seguridad automática antes de restaurar.

## Dónde se guardan los datos

- Configuración: `%APPDATA%\CraftPanel\config.json`
- Servidores: `%APPDATA%\CraftPanel\servers\`
- Cada servidor tiene un archivo `craftpanel.json` con sus datos.

Puedes cambiar la carpeta de servidores desde **Ajustes**.

## Pruebas

Las pruebas del núcleo se ejecutan con Electron:

```bat
npm test
```

Las pruebas E2E descargan servidores reales en una carpeta temporal y pueden tardar varios minutos:

```bat
npx electron scripts/e2e.js --user-data-dir=%TEMP%\craftpanel-e2e-paper
npx electron scripts/e2e-bedrock.js --user-data-dir=%TEMP%\craftpanel-e2e-bedrock
npx electron scripts/e2e-fabric.js --user-data-dir=%TEMP%\craftpanel-e2e-fabric
```

Puedes borrar esas carpetas de `%TEMP%` cuando termines.

## Estructura del proyecto

```text
main.js                 Proceso principal de Electron e IPC
preload.js              API segura expuesta al renderer
src/core/               Lógica: versiones, instalación, procesos, red, UPnP, copias, ZIP
src/renderer/           Interfaz (HTML, CSS y JavaScript sin bundler)
scripts/                Pruebas automáticas
```

## Notas

- No edites `server.properties` mientras el servidor está en ejecución: Minecraft lo sobrescribe al apagarse. CraftPanel bloquea esa edición.
- Al cerrar la app con servidores encendidos, se detienen para guardar el mundo correctamente.
- El proyecto no incluye binarios de Minecraft, Java ni cloudflared; se descargan o se detectan en el equipo.
