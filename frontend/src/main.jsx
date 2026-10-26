import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';
import './index.css';

import { PrivyProvider } from '@privy-io/react-auth';
import { WagmiProvider } from '@privy-io/wagmi';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { baseSepolia, mainnet, base } from 'viem/chains';
import { wagmiConfig } from './config/chains';

const queryClient = new QueryClient();

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <PrivyProvider
      appId="cmriav2u300wd0cjnf2wy07xb"
      config={{
        loginMethods: ['wallet', 'email'],
        // Putting baseSepolia first makes it Privy's defaultChain while keeping WalletConnect v2
        // namespaces optional (including mainnet/base) so Mobile MetaMask on Android/iOS never
        // rejects the pairing if the user has not pre-added Base Sepolia in MetaMask yet.
        supportedChains: [baseSepolia, mainnet, base],
        fundingConfig: {
          targetChain: baseSepolia,
        },
        appearance: {
          theme: 'light',
          walletChainType: 'ethereum-only',
          showWalletLoginFirst: true,
          walletList: [
            'metamask',
            'wallet_connect',
            'coinbase_wallet',
            'rainbow',
            'detected_ethereum_wallets',
          ],
        },
        externalWallets: {
          walletConnect: {
            enabled: true,
          },
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
