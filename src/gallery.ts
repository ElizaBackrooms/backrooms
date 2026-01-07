interface ImageArtifact {
  id: string;
  timestamp: string;
  agent: string;
  imageUrl: string;
  localPath: string;
  prompt: string;
  thought: string;
  conversationContext: string;
}

let galleryImages: ImageArtifact[] = [];

// Load gallery on page load
async function loadGallery() {
  try {
    const response = await fetch('/api/gallery');
    const data = await response.json();
    galleryImages = data.images || [];
    
    renderGallery();
    updateStats();
  } catch (error) {
    console.error('Error loading gallery:', error);
    const gallery = document.getElementById('gallery');
    if (gallery) {
      gallery.innerHTML = '<div class="empty">Error loading gallery. Please refresh.</div>';
    }
  }
}

// Render gallery grid
function renderGallery() {
  const gallery = document.getElementById('gallery');
  if (!gallery) return;
  
  if (galleryImages.length === 0) {
    gallery.innerHTML = '<div class="empty">No images generated yet. Check back soon...</div>';
    return;
  }
  
  gallery.innerHTML = galleryImages.map(img => `
    <div class="gallery-item" data-id="${img.id}">
      <img src="/gallery/${img.localPath}" alt="${img.thought}" loading="lazy">
      <div class="gallery-overlay">
        <div class="gallery-agent ${img.agent === 'CLAUDE_ALPHA' ? 'alpha' : 'omega'}">
          ${img.agent}
        </div>
        <div class="gallery-timestamp">
          ${new Date(img.timestamp).toLocaleString()}
        </div>
      </div>
    </div>
  `).join('');
  
  // Add click handlers
  document.querySelectorAll('.gallery-item').forEach(item => {
    item.addEventListener('click', () => {
      const id = item.getAttribute('data-id');
      const image = galleryImages.find(img => img.id === id);
      if (image) openModal(image);
    });
  });
}

// Update statistics
function updateStats() {
  const totalCount = galleryImages.length;
  const alphaCount = galleryImages.filter(img => img.agent === 'CLAUDE_ALPHA').length;
  const omegaCount = galleryImages.filter(img => img.agent === 'CLAUDE_OMEGA').length;
  
  const totalEl = document.getElementById('total-count');
  const alphaEl = document.getElementById('alpha-count');
  const omegaEl = document.getElementById('omega-count');
  
  if (totalEl) totalEl.textContent = totalCount.toString();
  if (alphaEl) alphaEl.textContent = alphaCount.toString();
  if (omegaEl) omegaEl.textContent = omegaCount.toString();
}

// Open modal with image details
function openModal(image: ImageArtifact) {
  const modal = document.getElementById('image-modal');
  if (!modal) return;
  
  const imgEl = document.getElementById('modal-image');
  const agentEl = document.getElementById('modal-agent');
  const timestampEl = document.getElementById('modal-timestamp');
  const thoughtEl = document.getElementById('modal-thought');
  const contextEl = document.getElementById('modal-context');
  const promptEl = document.getElementById('modal-prompt');
  
  if (imgEl) imgEl.setAttribute('src', `/gallery/${image.localPath}`);
  if (agentEl) agentEl.textContent = image.agent;
  if (timestampEl) timestampEl.textContent = new Date(image.timestamp).toLocaleString();
  if (thoughtEl) thoughtEl.textContent = image.thought;
  if (contextEl) contextEl.textContent = image.conversationContext || 'No context available';
  if (promptEl) promptEl.textContent = image.prompt;
  
  modal.style.display = 'block';
}

// Close modal
const closeModal = document.getElementById('close-modal');
if (closeModal) {
  closeModal.addEventListener('click', () => {
    const modal = document.getElementById('image-modal');
    if (modal) modal.style.display = 'none';
  });
}

// Close modal on outside click
window.addEventListener('click', (event) => {
  const modal = document.getElementById('image-modal');
  if (event.target === modal && modal) {
    modal.style.display = 'none';
  }
});

// Initialize
loadGallery();

// Refresh gallery every 5 minutes
setInterval(loadGallery, 5 * 60 * 1000);

