# Floorplan Engine: Real-Time Dynamic Space Planner

This project is a high-fidelity interactive floorplan application designed for expos and conferences. It serves a real-time web portal where buyers can view details, inspect click rates, see live presence indicators, and book spaces instantly. It also includes an Admin Console to handle dynamic booth consolidations (combining adjacent spaces programmatically).

## Features
*   **Vector Floorplan Viewer:** Responsive, zoomable, and pannable SVG map.
*   **Presence Channel Sync:** Instantly counts and shows how many visitors are hovering over individual booths right now.
*   **Booking Stream:** Instant color updates (Amber to Blue) when a booth is purchased, along with ticker announcements.
*   **Consolidation Engine:** Admin tool to merge booths, recalculating geometric boundaries and combining prices in real-time.
*   **Unified Service:** Serves both frontend and backend WebSockets from a single Node.js process, making it free and easy to deploy on Render.

---

## 1. Running Locally

### Prerequisites
Make sure you have [Node.js](https://nodejs.org/) installed.

### Installation
Open your terminal in this workspace folder and run:
```bash
npm install
```

### Start Development Server
To launch with hot-reloading (automatically restarts on file changes):
```bash
npm run dev
```
Alternatively, start the production server:
```bash
npm start
```

Once running, open **`http://localhost:3000`** in multiple browser tabs side-by-side to witness real-time clicks, active viewers, booking synchronizations, and consolidation changes.

---

## 2. Pushing to GitHub

To deploy on Render, you first need to host this code in your GitHub repository.

1.  **Initialize Git Repository:**
    ```bash
    git init
    ```
2.  **Add all files:**
    ```bash
    git add .
    ```
3.  **Commit the files:**
    ```bash
    git commit -m "feat: initial interactive real-time floorplan release"
    ```
4.  **Create a Repository on GitHub:**
    *   Go to [github.com/new](https://github.com/new) and log in.
    *   Set the Repository Name (e.g., `realtime-floorplan`).
    *   Leave all template choices (README, gitignore) **unchecked**.
    *   Click **Create repository**.
5.  **Link and Push:**
    Copy the commands under *"…or push an existing repository from the command line"* in GitHub:
    ```bash
    git branch -M main
    git remote add origin https://github.com/<your-username>/<your-repo-name>.git
    git push -u origin main
    ```

---

## 3. Deploying to Render.com (100% Free)

Render connects directly to your GitHub repository and redeploys automatically whenever you push updates.

1.  **Sign Up / Sign In:**
    Go to [Render.com](https://render.com) and log in using your **GitHub account**.
2.  **Create a New Web Service:**
    *   Click the **New +** button in the top right.
    *   Select **Web Service**.
    *   Select **Build and deploy from a Git repository**.
3.  **Connect Your Repository:**
    *   Under *Connect a repository*, find the repo you just pushed (`realtime-floorplan`) and click **Connect**.
4.  **Configure Deployment Settings:**
    *   **Name:** `realtime-floorplan` (or any name you prefer)
    *   **Region:** Select the closest one to you.
    *   **Branch:** `main`
    *   **Runtime:** `Node`
    *   **Build Command:** `npm install`
    *   **Start Command:** `node server.js`
    *   **Instance Type:** `Free` (perfect for testing and prototypes)
5.  **Deploy:**
    *   Click **Deploy Web Service** at the bottom.
6.  **Verify & Test:**
    *   Once the build completes (takes about 1-2 minutes), Render will display a green `Live` status and output a link at the top (e.g., `https://realtime-floorplan.onrender.com`).
    *   Open this link on your phone and desktop simultaneously to test the live websocket integration in the wild!
