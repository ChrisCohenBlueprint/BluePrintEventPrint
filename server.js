const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

const PORT = process.env.PORT || 3000;

// Serve static files from the 'public' directory
app.use(express.static(path.join(__dirname, 'public')));

// Initial Floorplan Booth Data (simulated database)
// Standard layout with booths positioned in rows/blocks similar to the expo image.
const INITIAL_BOOTHS = [
  // Row 1 (Top Left)
  { id: '101', x: 50, y: 50, width: 40, height: 40, price: 3200, status: 'available', company: '', active: true },
  { id: '102', x: 95, y: 50, width: 40, height: 40, price: 3200, status: 'available', company: '', active: true },
  { id: '103', x: 140, y: 50, width: 40, height: 40, price: 3500, status: 'available', company: '', active: true },
  { id: '104', x: 185, y: 50, width: 40, height: 40, price: 3500, status: 'sold', company: 'Global Tech Inc.', active: true },
  { id: '105', x: 230, y: 50, width: 40, height: 40, price: 3200, status: 'available', company: '', active: true },

  // Row 1 (Top Right)
  { id: '106', x: 400, y: 50, width: 40, height: 40, price: 3800, status: 'available', company: '', active: true },
  { id: '107', x: 445, y: 50, width: 40, height: 40, price: 3800, status: 'available', company: '', active: true },
  { id: '108', x: 490, y: 50, width: 40, height: 40, price: 4000, status: 'available', company: '', active: true },
  { id: '109', x: 535, y: 50, width: 40, height: 40, price: 4000, status: 'available', company: '', active: true },
  { id: '110', x: 580, y: 50, width: 40, height: 40, price: 3800, status: 'available', company: '', active: true },

  // Row 2
  { id: '201', x: 50, y: 110, width: 40, height: 40, price: 2800, status: 'available', company: '', active: true },
  { id: '202', x: 95, y: 110, width: 40, height: 40, price: 2800, status: 'available', company: '', active: true },
  { id: '203', x: 140, y: 110, width: 40, height: 40, price: 3000, status: 'available', company: '', active: true },
  { id: '204', x: 185, y: 110, width: 40, height: 40, price: 3000, status: 'available', company: '', active: true },
  
  // Premium Center Area
  { id: 'VIP 1', x: 270, y: 110, width: 90, height: 90, price: 8500, status: 'available', company: '', active: true },
  
  { id: '205', x: 400, y: 110, width: 40, height: 40, price: 3000, status: 'available', company: '', active: true },
  { id: '206', x: 445, y: 110, width: 40, height: 40, price: 3000, status: 'sold', company: 'Apex Logistics', active: true },
  { id: '207', x: 490, y: 110, width: 40, height: 40, price: 2800, status: 'available', company: '', active: true },
  { id: '208', x: 535, y: 110, width: 40, height: 40, price: 2800, status: 'available', company: '', active: true },

  // Row 3
  { id: '301', x: 50, y: 220, width: 40, height: 40, price: 2600, status: 'available', company: '', active: true },
  { id: '302', x: 95, y: 220, width: 40, height: 40, price: 2600, status: 'available', company: '', active: true },
  { id: '303', x: 140, y: 220, width: 40, height: 40, price: 2800, status: 'available', company: '', active: true },
  { id: '304', x: 185, y: 220, width: 40, height: 40, price: 2800, status: 'available', company: '', active: true },
  
  // Center Row 3
  { id: 'NETWORKING', x: 250, y: 220, width: 130, height: 80, price: 0, status: 'amenity', company: 'Community Zone', active: true },
  
  { id: '305', x: 400, y: 220, width: 40, height: 40, price: 2800, status: 'available', company: '', active: true },
  { id: '306', x: 445, y: 220, width: 40, height: 40, price: 2800, status: 'available', company: '', active: true },
  { id: '307', x: 490, y: 220, width: 40, height: 40, price: 2600, status: 'available', company: '', active: true },
  { id: '308', x: 535, y: 220, width: 40, height: 40, price: 2600, status: 'available', company: '', active: true },

  // Row 4 (Large Bottom blocks)
  { id: '401', x: 50, y: 320, width: 85, height: 60, price: 5500, status: 'available', company: '', active: true },
  { id: '402', x: 140, y: 320, width: 85, height: 60, price: 5500, status: 'available', company: '', active: true },
  { id: 'STAGE A', x: 250, y: 320, width: 130, height: 60, price: 0, status: 'amenity', company: 'Keynote Theatre', active: true },
  { id: '403', x: 400, y: 320, width: 85, height: 60, price: 5500, status: 'available', company: '', active: true },
  { id: '404', x: 490, y: 320, width: 85, height: 60, price: 5500, status: 'available', company: '', active: true }
];

let booths = JSON.parse(JSON.stringify(INITIAL_BOOTHS));

// Track active viewers on each booth (Socket ID -> Booth ID)
const activeViewers = {};
// Real-time click counters for analytics (Booth ID -> Click Count)
const clickAnalytics = {};
// Initialize clicks
booths.forEach(b => {
  clickAnalytics[b.id] = Math.floor(Math.random() * 15) + 3; // populate with some mock initial analytics
});

// Helper to calculate booth viewer count
function getViewerCountForBooth(boothId) {
  return Object.values(activeViewers).filter(id => id === boothId).length;
}

// Helper to broadcast state changes
function broadcastState() {
  const updatedBooths = booths.map(b => ({
    ...b,
    viewerCount: getViewerCountForBooth(b.id),
    clicks: clickAnalytics[b.id] || 0
  }));
  io.emit('booths-update', {
    booths: updatedBooths,
    connections: io.engine.clientsCount
  });
}

io.on('connection', (socket) => {
  console.log(`Client connected: ${socket.id}`);
  
  // Send current state to newly connected client
  broadcastState();

  // Handle viewer starting to view a booth
  socket.on('start-viewing', (boothId) => {
    activeViewers[socket.id] = boothId;
    broadcastState();
  });

  // Handle viewer stopping view
  socket.on('stop-viewing', () => {
    delete activeViewers[socket.id];
    broadcastState();
  });

  // Track clicks for analytics
  socket.on('track-click', (boothId) => {
    if (clickAnalytics[boothId] !== undefined) {
      clickAnalytics[boothId] += 1;
    } else {
      clickAnalytics[boothId] = 1;
    }
    broadcastState();
  });

  // Handle booking a booth
  socket.on('book-booth', ({ boothId, companyName }) => {
    const booth = booths.find(b => b.id === boothId && b.active);
    if (booth && booth.status === 'available') {
      booth.status = 'sold';
      booth.company = companyName;
      broadcastState();
      
      // Notify all clients of a successful booking alert
      io.emit('booking-announcement', {
        boothId,
        companyName,
        timestamp: new Date().toLocaleTimeString()
      });
    }
  });

  // Handle admin releasing a booth
  socket.on('release-booth', (boothId) => {
    const booth = booths.find(b => b.id === boothId && b.active);
    if (booth) {
      booth.status = 'available';
      booth.company = '';
      broadcastState();
    }
  });

  // Handle consolidating (merging) two booths
  socket.on('consolidate-booths', ({ boothId1, boothId2 }) => {
    const booth1 = booths.find(b => b.id === boothId1 && b.active);
    const booth2 = booths.find(b => b.id === boothId2 && b.active);

    if (!booth1 || !booth2 || booth1.status === 'amenity' || booth2.status === 'amenity') {
      socket.emit('error-msg', 'Cannot consolidate: Selected spaces must be active booths.');
      return;
    }

    // Determine spatial layout merge
    // We consolidate side-by-side or stacked booths.
    // For simplicity, we create a unified bounding box:
    const minX = Math.min(booth1.x, booth2.x);
    const minY = Math.min(booth1.y, booth2.y);
    const maxX = Math.max(booth1.x + booth1.width, booth2.x + booth2.width);
    const maxY = Math.max(booth1.y + booth1.height, booth2.y + booth2.height);

    // Update booth1 to encompass the full merged area
    booth1.x = minX;
    booth1.y = minY;
    booth1.width = maxX - minX;
    booth1.height = maxY - minY;
    
    // Combine pricing
    booth1.price = booth1.price + booth2.price;
    
    // If one booth is sold, the consolidated booth inherits the booking
    if (booth2.status === 'sold' && booth1.status !== 'sold') {
      booth1.status = 'sold';
      booth1.company = booth2.company;
    }
    
    // Deactivate booth2
    booth2.active = false;
    
    // Clean up active viewers on booth2
    Object.keys(activeViewers).forEach(sid => {
      if (activeViewers[sid] === boothId2) {
        activeViewers[sid] = boothId1; // redirect to consolidated booth
      }
    });

    // Merge click analytics
    clickAnalytics[boothId1] = (clickAnalytics[boothId1] || 0) + (clickAnalytics[boothId2] || 0);
    delete clickAnalytics[boothId2];

    broadcastState();
    
    io.emit('notification', `Booths ${boothId1} and ${boothId2} have been consolidated into booth ${boothId1}.`);
  });

  // Reset demo state
  socket.on('reset-demo', () => {
    booths = JSON.parse(JSON.stringify(INITIAL_BOOTHS));
    Object.keys(activeViewers).forEach(k => delete activeViewers[k]);
    booths.forEach(b => {
      clickAnalytics[b.id] = Math.floor(Math.random() * 15) + 3;
    });
    broadcastState();
    io.emit('notification', 'Floorplan demo has been reset to default.');
  });

  socket.on('disconnect', () => {
    console.log(`Client disconnected: ${socket.id}`);
    delete activeViewers[socket.id];
    broadcastState();
  });
});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
