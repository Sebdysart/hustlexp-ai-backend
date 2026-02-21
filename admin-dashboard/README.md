# HustleXP Admin Dashboard

Operations dashboard for managing the HustleXP platform.

## Features

- **Overview Dashboard**: Key metrics and activity summary
- **User Management**: View and manage users
- **Task Moderation**: Review and moderate tasks
- **Dispute Resolution**: Handle disputes between users
- **Payment Monitoring**: Track payments and payouts
- **AI Cost Tracking**: Monitor AI spend by agent
- **Settings**: Platform configuration

## Getting Started

```bash
npm install
npm run dev
```

Open [http://localhost:3001](http://localhost:3001).

## Environment Variables

```bash
BACKEND_URL=http://localhost:3000
```

## Building for Production

```bash
npm run build
npm start
```

## Deployment

This dashboard should be deployed to a separate service (Vercel recommended) with authentication middleware protecting all routes.
