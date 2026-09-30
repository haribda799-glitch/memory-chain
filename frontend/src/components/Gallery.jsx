import { useState, useMemo, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useReadContract, useReadContracts, useChainId } from 'wagmi';
import { CONTRACT_ABI } from '../config/contract';
import { getContractAddress } from '../config/chains';
import { getArweaveUrl } from '../utils/arweave';
import MemorialCard from './MemorialCard';

function SkeletonCard() {
  return (
    <div className="bg-surface rounded-[16px] border border-outline-variant/20 overflow-hidden group flex flex-col animate-pulse">
      <div className="relative h-64 overflow-hidden bg-surface-container-highest" />
      <div className="p-6 flex flex-col flex-grow">
        <div className="flex justify-between items-start mb-4">
          <div className="w-full space-y-2">
            <div className="h-6 bg-surface-container-highest rounded w-3/4" />
            <div className="h-3 bg-surface-container-highest rounded w-1/2" />
          </div>
        </div>
      </div>
    </div>
  );
}

import { useMemorials } from '../utils/useMemorials';

export default function Gallery() {
  const navigate = useNavigate();

  // State management
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState('all');
  const [sortBy, setSortBy] = useState('newest');
  const [visibleCount, setVisibleCount] = useState(12);
  const [metadataMap, setMetadataMap] = useState({});

  const { memorials: rawMemorials, isLoading, refetch } = useMemorials();

  // Background fetch for Arweave JSON metadata for search/filter parsing
  useEffect(() => {
    if (!rawMemorials || rawMemorials.length === 0) return;
    rawMemorials.forEach((m) => {
      const isVisible = m.isVisible !== undefined ? m.isVisible : (!m.isHidden && !m.isBanned && m.isPublic);
      if (!isVisible || !m.arweaveUri || metadataMap[m.arweaveUri]) return;

      fetch(getArweaveUrl(m.arweaveUri))
        .then((r) => (r.ok ? r.json() : null))
        .then((data) => {
          setMetadataMap((prev) => ({
            ...prev,
            [m.arweaveUri]: data || { species: 'companion', category: 'other' },
          }));
        })
        .catch(() => {
          setMetadataMap((prev) => ({
            ...prev,
            [m.arweaveUri]: { species: 'companion', category: 'other' },
          }));
        });
    });
  }, [rawMemorials, metadataMap]);

  // Aggregate all public and non-hidden memorials with metadata
  const allMemorials = useMemo(() => {
    if (!rawMemorials) return [];
    const items = [];
    try {
      rawMemorials.forEach((m) => {
        const isVisible = m.isVisible !== undefined ? m.isVisible : (!m.isHidden && !m.isBanned && m.isPublic);
        if (!isVisible) return; // Moderation & Privacy filters (is_memorial_visible)

        const meta = metadataMap[m.arweaveUri] || {};
        const description = meta.description || meta.epitaph || m.description || m.story || '';
        const attrs = Array.isArray(meta.attributes) ? meta.attributes : [];
        const findAttr = (trait) => attrs.find((a) => a.trait_type === trait)?.value;
        const metaSpecies = meta.species || findAttr('Species');
        const metaBreed = meta.breed || findAttr('Breed');
        const metaCategory = meta.category;

        const species = String(metaSpecies || m.species || 'companion').toLowerCase();
        const breed = String(metaBreed || m.breed || '').toLowerCase();
        const category = String(metaCategory || m.category || (species !== 'companion' ? species : 'other')).toLowerCase();

        items.push({
          tokenId: m.tokenId || m.id,
          petName: m.petName,
          arweaveUri: m.arweaveUri,
          createdAt: Number(m.createdAt || 0),
          isPublic: m.isPublic,
          isHidden: m.isHidden,
          isBanned: m.isBanned,
          isFlagged: m.isFlagged,
          owner: m.owner,
          candleCount: 0,
          species,
          breed,
          category,
          description,
        });
      });
    } catch (err) {
      console.error('[Gallery] Error building allMemorials:', err);
    }
    return items;
  }, [rawMemorials, metadataMap]);

  // Dynamic category pill counts
  const categoryCounts = useMemo(() => {
    let dog = 0, cat = 0, horse = 0, other = 0;
    allMemorials.forEach((m) => {
      const sp = (m.species || '').toLowerCase();
      const br = (m.breed || '').toLowerCase();
      const catVal = (m.category || '').toLowerCase();

      const isDog = sp.includes('dog') || br.includes('dog') || catVal.includes('dog');
      const isCat = sp.includes('cat') || br.includes('cat') || catVal.includes('cat');
      const isHorse = sp.includes('horse') || br.includes('horse') || catVal.includes('horse');
      if (isDog) dog++;
      else if (isCat) cat++;
      else if (isHorse) horse++;
      else other++;
    });
    return { all: allMemorials.length, dog, cat, horse, other };
  }, [allMemorials]);

  // Filter & Sort
  const filteredMemorials = useMemo(() => {
    let result = [...allMemorials];

    // 1. Search filter
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase().trim();
      result = result.filter(
        (m) =>
          (m.petName || '').toLowerCase().includes(q) ||
          (m.breed || '').toLowerCase().includes(q) ||
          (m.species || '').toLowerCase().includes(q) ||
          (m.category || '').toLowerCase().includes(q) ||
          (m.description || '').toLowerCase().includes(q)
      );
    }

    // 2. Category filter
    if (selectedCategory !== 'all') {
      result = result.filter((m) => {
        const sp = (m.species || '').toLowerCase();
        const br = (m.breed || '').toLowerCase();
        const catVal = (m.category || '').toLowerCase();

        const isDog = sp.includes('dog') || br.includes('dog') || catVal.includes('dog');
        const isCat = sp.includes('cat') || br.includes('cat') || catVal.includes('cat');
        const isHorse = sp.includes('horse') || br.includes('horse') || catVal.includes('horse');
        if (selectedCategory === 'dog') return isDog;
        if (selectedCategory === 'cat') return isCat;
        if (selectedCategory === 'horse') return isHorse;
        if (selectedCategory === 'other') return !isDog && !isCat && !isHorse;
        return true;
      });
    }

    // 3. Sorting
    result.sort((a, b) => {
      if (sortBy === 'newest') {
        return b.tokenId - a.tokenId;
      }
      if (sortBy === 'oldest') {
        return a.tokenId - b.tokenId;
      }
      if (sortBy === 'candles') {
        return b.candleCount - a.candleCount;
      }
      return 0;
    });

    return result;
  }, [allMemorials, searchQuery, selectedCategory, sortBy]);

  return (
    <>
      {/* Hero Section */}
      <section className="relative w-full min-h-[80vh] flex items-center bg-surface-container-low px-margin-mobile md:px-margin-desktop overflow-hidden">
        <div className="absolute inset-0 z-0">
          <img
            alt="Hero background"
            className="w-full h-full object-cover opacity-90"
            src="https://lh3.googleusercontent.com/aida-public/AB6AXuDu5JCtYBQCGHxS5qbJCGOcTajrmvY_TBDdGeeEONM6t7A2e7Co2fBYROf8rqlRuRBZOgGJHLOQYnwaqJhdJyicxxv_bWDSDp5NBZN_dCxjVw3FETh7zEqKtVabByMFexHpU_4JLG1SDV48ugDHNzaREVwVxpZK3gFiM594mZbD_QCAoRU4-5MoIFmMb7NB6ZWuG40qCqSVnTCvEkEyHNpAId4jLjrLXDfS65tenaRaX1ObCg_b_gC5spbXOOoelVF_H6oHcxil0q8"
          />
          <div className="absolute inset-0 bg-gradient-to-r from-surface-container-low via-surface-container-low/80 to-transparent"></div>
        </div>
        <div className="relative z-10 max-w-container-max mx-auto w-full grid grid-cols-1 md:grid-cols-2 gap-gutter">
          <div className="flex flex-col justify-center space-y-stack-md py-20">
            <h1 className="font-display-lg-mobile md:font-display-lg text-display-lg-mobile md:text-display-lg text-on-surface">
              Eternal memory for your beloved friend.
            </h1>
            <p className="font-body-lg text-body-lg text-on-surface-variant max-w-lg">
              Preserved on-chain forever. A sanctuary of peace, ensuring their legacy outlasts time itself.
            </p>
            <div className="pt-4">
              <button
                onClick={() => navigate('/create')}
                className="bg-primary-container text-on-primary-container px-8 py-4 rounded-[16px] font-label-md text-label-md uppercase tracking-wider hover:bg-surface-tint hover:text-on-primary transition-colors shadow-sm"
              >
                Create Eternal Memorial
              </button>
            </div>
          </div>
        </div>
      </section>

      {/* Trust Block (Web3 Explanation) */}
      <section className="py-24 px-margin-mobile md:px-margin-desktop bg-surface max-w-container-max mx-auto">
        <div className="text-center max-w-3xl mx-auto mb-16">
          <h2 className="font-headline-md text-headline-md text-on-surface mb-6">A Permanent Sanctuary</h2>
          <p className="font-body-lg text-body-lg text-on-surface-variant">
            Unlike traditional websites, memorials on Memory Chain are woven into the blockchain. They are permanent, immutable, and immune to server shutdowns. Your companion's memory belongs to you and time alone.
          </p>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-gutter">
          <div className="bg-surface-container-low p-8 rounded-xl border border-outline-variant/30 flex flex-col items-center text-center space-y-4 transition-transform hover:-translate-y-1 duration-300">
            <div className="w-16 h-16 rounded-full bg-secondary-container flex items-center justify-center text-on-secondary-container mb-2">
              <span className="material-symbols-outlined text-3xl" style={{ fontVariationSettings: "'FILL' 0" }}>all_inclusive</span>
            </div>
            <h3 className="font-headline-sm text-headline-sm text-on-surface">Eternal Persistence</h3>
            <p className="font-body-sm text-body-sm text-on-surface-variant">Stored on decentralized networks, meaning no single entity can ever delete or alter the memorial.</p>
          </div>
          <div className="bg-surface-container-low p-8 rounded-xl border border-outline-variant/30 flex flex-col items-center text-center space-y-4 transition-transform hover:-translate-y-1 duration-300">
            <div className="w-16 h-16 rounded-full bg-secondary-container flex items-center justify-center text-on-secondary-container mb-2">
              <span className="material-symbols-outlined text-3xl" style={{ fontVariationSettings: "'FILL' 0" }}>shield_lock</span>
            </div>
            <h3 className="font-headline-sm text-headline-sm text-on-surface">Immutable Record</h3>
            <p className="font-body-sm text-body-sm text-on-surface-variant">Every photo and tribute is cryptographically secured, preserving the pristine truth of their life.</p>
          </div>
          <div className="bg-surface-container-low p-8 rounded-xl border border-outline-variant/30 flex flex-col items-center text-center space-y-4 transition-transform hover:-translate-y-1 duration-300">
            <div className="w-16 h-16 rounded-full bg-secondary-container flex items-center justify-center text-on-secondary-container mb-2">
              <span className="material-symbols-outlined text-3xl" style={{ fontVariationSettings: "'FILL' 0" }}>favorite</span>
            </div>
            <h3 className="font-headline-sm text-headline-sm text-on-surface">Compassionate Space</h3>
            <p className="font-body-sm text-body-sm text-on-surface-variant">Designed with gentle minimalism to provide a quiet place for reflection and remembrance.</p>
          </div>
        </div>
      </section>

      {/* Gallery Section */}
      <section className="py-24 px-margin-mobile md:px-margin-desktop bg-surface-container-low">
        <div className="max-w-container-max mx-auto">
          <div className="flex justify-between items-end mb-8">
            <h2 className="font-headline-md text-headline-md text-on-surface">In Loving Memory</h2>
            <div className="font-label-md text-label-md text-primary uppercase tracking-wider hidden sm:block">
              {isLoading ? 'Loading...' : `${filteredMemorials.length} Memorial${filteredMemorials.length !== 1 ? 's' : ''}`}
            </div>
          </div>

          {/* Control Panel: Search + Category Pills + Sort Dropdown */}
          <div className="bg-white rounded-2xl border border-[#d8c2ba]/30 p-6 mb-10 shadow-sm space-y-6">
            {/* Top Row: Search Input + Sort Dropdown */}
            <div className="flex flex-col md:flex-row gap-4 items-center justify-between">
              {/* Search Input */}
              <div className="relative w-full md:w-96">
                <span className="material-symbols-outlined absolute left-3.5 top-1/2 -translate-y-1/2 text-[#85736d] text-lg pointer-events-none">
                  search
                </span>
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => {
                    setSearchQuery(e.target.value);
                    setVisibleCount(12);
                  }}
                  placeholder="Search by name, breed, or story..."
                  className="w-full pl-10 pr-10 py-2.5 bg-[#fbf9f6] border border-[#d8c2ba]/50 rounded-xl text-sm text-[#1b1c1a] placeholder-[#85736d] focus:border-[#8a4f36] focus:ring-1 focus:ring-[#8a4f36] outline-none transition-all"
                />
                {searchQuery && (
                  <button
                    type="button"
                    onClick={() => {
                      setSearchQuery('');
                      setVisibleCount(12);
                    }}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-[#85736d] hover:text-[#1b1c1a] p-1 rounded-full text-xs transition-colors"
                  >
                    ✕
                  </button>
                )}
              </div>

              {/* Sort Dropdown */}
              <div className="flex items-center gap-2 w-full md:w-auto justify-end">
                <span className="text-xs font-semibold tracking-wider uppercase text-[#85736d] whitespace-nowrap">
                  Sort by:
                </span>
                <select
                  value={sortBy}
                  onChange={(e) => setSortBy(e.target.value)}
                  className="bg-[#fbf9f6] border border-[#d8c2ba]/50 rounded-xl px-3 py-2 text-xs font-semibold text-[#1b1c1a] cursor-pointer focus:border-[#8a4f36] outline-none transition-colors"
                >
                  <option value="newest">Newest First</option>
                  <option value="candles">Most Lit Candles</option>
                  <option value="oldest">Oldest First</option>
                </select>
              </div>
            </div>

            {/* Category Pills */}
            <div className="flex flex-wrap gap-2 pt-2 border-t border-[#f0ece9]">
              {[
                { id: 'all', label: 'All', count: categoryCounts.all },
                { id: 'dog', label: 'Dogs', count: categoryCounts.dog },
                { id: 'cat', label: 'Cats', count: categoryCounts.cat },
                { id: 'horse', label: 'Horses', count: categoryCounts.horse },
                { id: 'other', label: 'Other', count: categoryCounts.other },
              ].map((cat) => {
                const isActive = selectedCategory === cat.id;
                return (
                  <button
                    key={cat.id}
                    type="button"
                    onClick={() => {
                      setSelectedCategory(cat.id);
                      setVisibleCount(12);
                    }}
                    className={`px-4 py-2 rounded-xl text-xs font-semibold tracking-wide transition-all duration-200 flex items-center gap-2 ${
                      isActive
                        ? 'bg-[#8a4f36] text-white shadow-sm'
                        : 'bg-white text-[#53433e] border border-[#d8c2ba]/40 hover:bg-[#fbf9f6]'
                    }`}
                  >
                    <span>{cat.label}</span>
                    <span
                      className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${
                        isActive ? 'bg-white/20 text-white' : 'bg-[#f0ece9] text-[#85736d]'
                      }`}
                    >
                      {cat.count}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
          
          {isLoading ? (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-gutter">
              {[0, 1, 2, 3, 4, 5].map((i) => (
                <SkeletonCard key={i} />
              ))}
            </div>
          ) : filteredMemorials.length === 0 ? (
            /* Empathetic Empty State */
            <div className="bg-white rounded-2xl border border-[#d8c2ba]/30 p-12 text-center max-w-md mx-auto my-12 space-y-4 shadow-sm">
              <div className="w-16 h-16 rounded-full bg-[#f5efe6] text-2xl flex items-center justify-center mx-auto">
                🕯️
              </div>
              <h3
                className="text-xl font-headline-sm text-[#1b1c1a]"
                style={{ fontFamily: "'Libre Caslon Text', serif" }}
              >
                No memorials found
              </h3>
              <p className="text-sm text-[#53433e] leading-relaxed">
                We couldn't find any memorial matching your criteria. Try adjusting your search or filters.
              </p>
              <button
                type="button"
                onClick={() => {
                  setSearchQuery('');
                  setSelectedCategory('all');
                  setVisibleCount(12);
                }}
                className="inline-flex items-center gap-2 bg-[#8a4f36] text-white px-6 py-2.5 rounded-xl text-xs font-semibold uppercase tracking-wider hover:opacity-90 transition-opacity"
              >
                Reset All Filters
              </button>
            </div>
          ) : (
            <>
              {/* Grid of Memorial Cards */}
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-gutter">
                {filteredMemorials.slice(0, visibleCount).map((item) => (
                  <MemorialCard
                    key={item.tokenId}
                    tokenId={item.tokenId}
                    petName={item.petName}
                    arweaveUri={item.arweaveUri}
                    arweaveTxId={item.arweaveUri}
                    createdAt={item.createdAt}
                    ownerAddress={item.owner}
                    isPublic={item.isPublic}
                    isHidden={item.isHidden}
                    isBanned={item.isBanned}
                    isFlagged={item.isFlagged}
                    species={item.species}
                    category={item.category}
                    breed={item.breed}
                    memorial={item}
                    onUpdate={refetch}
                  />
                ))}
              </div>

              {/* Load More Button */}
              {filteredMemorials.length > visibleCount && (
                <div className="text-center pt-12">
                  <button
                    type="button"
                    onClick={() => setVisibleCount((prev) => prev + 12)}
                    className="bg-white border border-[#8a4f36] text-[#8a4f36] px-8 py-3.5 rounded-2xl text-xs font-semibold uppercase tracking-wider hover:bg-[#8a4f36] hover:text-white transition-colors duration-200 shadow-sm"
                  >
                    Show More Memorials ({filteredMemorials.length - visibleCount} remaining)
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </section>
    </>
  );
}

