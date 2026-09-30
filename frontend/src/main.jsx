import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';
import './index.css';

import { PrivyProvider } from '@privy-io/react-auth';
import { WagmiProvider } from '@privy-io/wagmi';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { baseSepolia } from 'viem/chains';
import { wagmiConfig } from './config/chains';

const queryClient = new QueryClient();

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <PrivyProvider
      appId="cmriav2u300wd0cjnf2wy07xb"
      config={{
        loginMethods: ['wallet', 'email'],
        defaultChain: baseSepolia,
        supportedChains: [baseSepolia],
        fundingConfig: {
          targetChain: baseSepolia,
        },
        appearance: {
          theme: 'light',
          walletChainType: 'ethereum-only',
          showWalletLoginFirst: true,
        },
        externalWallets: {
          walletList: ['metamask', 'detected_ethereum_wallets'],
        },
        embeddedWallets: {
          createOnLogin: 'users-without-wallets',
          requireUserPasswordOnCreate: false,
        },
      }}
    >
      <QueryClientProvider client={queryClient}>
        <WagmiProvider config={wagmiConfig}>
          <App />
        </WagmiProvider>
      </QueryClientProvider>
    </PrivyProvider>
  </React.StrictMode>,
);
