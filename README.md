# Chartoon Networth Backend - Azure Deployment Guide

This backend is a production-ready Express server that automates stock selection and execution using the Zerodha Kite Connect API. This guide explains how to deploy and configure this application on **Microsoft Azure**.

---

## 🚀 Deployment Options

You can deploy this application using two primary methods on Azure:

1. **Azure App Service (Linux)**: Direct code deployment (Zip Deploy) – Recommended for quick setup.
2. **Azure Container Apps / App Service for Containers**: Containerized deployment using the provided `Dockerfile`.

---

## 🛠️ Step-by-Step Deployment Instructions

### Option A: Azure App Service (Linux Code Deploy) - Recommended

1. **Create an App Service**:
   - Go to the **Azure Portal**.
   - Create a new **Web App**.
   - Select **Linux** as the Operating System.
   - Select **Node 18 LTS** (or higher) as the Runtime Stack.
   - Choose your region and App Service Plan (Basic B1 tier or higher is recommended for production).

2. **Configure App Settings (Environment Variables)**:
   - Navigate to your Web App -> **Settings** -> **Configuration**.
   - Add the required environment variables listed in the [Environment Variables](#-environment-variables) section below.
   - Click **Save**.

3. **Enable "Always On" (CRITICAL)**:
   - In the Azure Portal, go to your Web App -> **Settings** -> **Configuration** -> **General settings**.
   - Toggle **Always on** to **On**.
   - *Note: This prevents Azure from putting the container to sleep during idle periods, ensuring that the cron jobs trigger on time at 9:15 AM and 10:00 AM IST.*

4. **Deploy using GitHub Actions**:
   - Download the **Publish Profile** from the Azure Web App overview page.
   - In your GitHub Repository, go to **Settings** -> **Secrets and variables** -> **Actions**.
   - Add a new repository secret:
     - Name: `AZURE_APP_SERVICE_PUBLISH_PROFILE`
     - Value: Paste the contents of the downloaded publish profile XML file.
   - Update the `.github/workflows/azure-deploy.yml` file with your Azure Web App name:
     ```yaml
     env:
       AZURE_WEBAPP_NAME: 'your-web-app-name-here'
     ```
   - Commit and push to the `main` branch to trigger the automatic deployment.

---

### Option B: Container Deployment (Docker)

This project includes a multi-stage, production-ready `Dockerfile` and `.dockerignore`.

1. **Build the Docker Image locally**:
   ```bash
   docker build -t chartoon-networth-be:latest .
   ```

2. **Verify container runs locally**:
   ```bash
   docker run -d -p 8080:8080 --env-file .env chartoon-networth-be:latest
   ```

3. **Deploy to Azure Container Registry (ACR) & Container Apps**:
   - Create an **Azure Container Registry** and push your built image to it.
   - Create an **Azure Container App** or **Azure Web App for Containers**.
   - Point the deployment to your ACR image.
   - Set the ingress port to `8080`.
   - Set the minimum scale replicas to `1` (do not scale down to `0` to keep the internal scheduler cron alive).

---

## 📋 Environment Variables

Configure the following Environment Variables under the **Configuration** (App Settings) tab in your Azure Web App:

| Variable Name | Required | Default | Description |
| :--- | :---: | :---: | :--- |
| `KITE_API_KEY` | **Yes** | - | Your Zerodha Kite API Key (plain text or encrypted with `enc:`) |
| `KITE_API_SECRET` | **Yes** | - | Your Zerodha Kite API Secret (plain text or encrypted with `enc:`) |
| `ENCRYPTION_KEY` | No | - | Decryption password (required if API key/secret are encrypted) |
| `REAL_TRADING` | No | `false` | Set to `true` ONLY if you want to place real stock orders with real money |
| `STOP_LOSS_PERCENT`| No | `0.75` | Stop loss threshold percentage |
| `TARGET_PERCENT` | No | `1.5` | Target profit threshold percentage |
| `SCORE_THRESHOLD` | No | `65` | Minimum strategy score (out of 100) required to trigger a Buy |
| `PORT` | No | `8080` | Port for the express app (Azure App Service automatically sets this) |
| `TZ` | **Yes** | `Asia/Kolkata`| Configures timezone for the internal cron scheduler |
| `WEBSITE_TIMEZONE`| **Yes** | `Asia/Kolkata`| System timezone variable used by Azure App Service Linux |

---

## ⏰ Timezone & Scheduler Notes

- The automation relies on `node-cron` scheduled events configured for **Indian Standard Time (IST)**.
- Setting **`WEBSITE_TIMEZONE = Asia/Kolkata`** and **`TZ = Asia/Kolkata`** ensures that the underlying OS clock aligns with Indian Market Hours, preventing misaligned stock scans.
- Daily market operations timeline:
  - **09:15 AM IST**: Automation scans the universe, ranks stocks, and triggers a BUY order if the score threshold is met.
  - **10:00 AM IST**: Time-based exit job executes, squaring off any active position.
  - **12:30 AM IST**: Daily state resets to prepare for the next trading session.

---

## 🔑 Kite Connect Callback URL Setup

When deploying to Azure, you must update your Redirect/Callback URL in the [Zerodha Developer Console](https://developers.kite.trade):
1. Log in and go to your app settings.
2. Select your app and locate the **Redirect URL** field.
3. Update it to point to your Azure App Service URL endpoint:
   `https://chartoon-networth-agfwgvapa9aaesgk.canadacentral-01.azurewebsites.net/api/auth/callback`
4. Update the `FRONTEND_URL` environment variable to allow CORS requests from your deployed dashboard.

---

## 💾 Session Storage & Ephemeral Files

- The backend persists the daily authentication token locally in `storage/session.json`.
- Because Zerodha sessions naturally expire every morning, the ephemeral file system used by Azure App Service containers is completely fine.
- If the App Service restarts or recycles, the session will be cleared. Simply visit the frontend dashboard and click **Connect** to authorize a new session for the day.

---

## 📈 EarlyEdge Morning Momentum Scanner (9:30 - 9:45 AM)

The Early Edge Morning Momentum Scanner is a modular trading assistant designed to identify high-probability continuation moves between **9:30 AM and 9:45 AM IST** on watched NSE stocks.

### 🌟 Key Features
- **Opening Range Engine (9:15 - 9:30)**: Calculates the high-low price boundary of the first 15 one-minute candles. Displays boundaries as horizontal lines on the chart.
- **Scoring Engine (0-100)**: Evaluates early morning momentum based on weighted factors:
  - *Opening Range Breakout (30% weight)*: Current price breaks OR High with volume confirmation.
  - *Volume Surge (20% weight)*: Latest candle volume is &ge; 1.8x the opening range average volume.
  - *Price vs VWAP (15% weight)*: Price is holding above the Volume Weighted Average Price.
  - *Relative Strength vs Nifty (20% weight)*: Outperforming the Nifty 50 index return since 9:15 AM.
  - *Candle Strength (15% weight)*: Last 3 candles are bullish (green) with higher highs.
- **Dynamic Targets & Stop Loss**: Recommends risk-managed targets and stop losses using ATR (Average True Range) and the Opening Range size.
- **Interactive Simulation Slider**: Drag the clock slider on the frontend tab to simulate any minute between 9:15 AM and 10:00 AM. Backend will generate stable, deterministic candles up to that time and recalculate all parameters for easy testing.
- **Real-Time Sockets**: Emits socket events (`opening_range_ready`, `scanner_update`) to sync dashboard metrics without page reloads.

### 🔌 API Endpoints
- `GET /api/early-edge/watchlist`: Fetch current early edge stock watchlist.
- `POST /api/early-edge/watchlist`: Update early edge stock watchlist.
- `GET /api/early-edge/scanner?simulatedTime=HH:MM:SS`: Run the momentum scanner (accepts optional simulated time).
- `GET /api/early-edge/chart?symbol=SYMBOL&simulatedTime=HH:MM:SS&interval=1m`: Fetch candle history (1m/3m) with VWAP and volume.
- `POST /api/early-edge/simulate`: Configure backend clock simulated time.

### 📡 Socket.io Broadcasts
- `opening_range_ready`: Emitted when the 15-minute Opening Range has locked at 9:30 AM.
- `scanner_update`: Emitted with new rankings as time advances.

