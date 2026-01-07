import { AgentRuntime, Memory, UUID } from '@elizaos/core';
import crypto from 'crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync, createWriteStream } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import https from 'https';

const __dirname = dirname(fileURLToPath(import.meta.url))

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

// Helper to access database adapter
function getDatabaseAdapter(runtime: AgentRuntime | null): any {
  if (!runtime) return null
  return (runtime as any).databaseAdapter || (runtime as any).database
}

class ScheduledImageGenerator {
  private alphaRuntime: AgentRuntime;
  private omegaRuntime: AgentRuntime;
  private backroomsRoomId: UUID;
  private intervalId: NodeJS.Timeout | null = null;
  private isGenerating: boolean = false;
  
  private nextAgent: 'ALPHA' | 'OMEGA' = 'ALPHA';
  private readonly IMAGE_INTERVAL = 5 * 60 * 1000; // 5 minutes
  
  private readonly GALLERY_DIR = join(__dirname, '../data/gallery');
  private readonly GALLERY_INDEX_FILE = join(this.GALLERY_DIR, 'gallery-index.json');
  
  private galleryImages: ImageArtifact[] = [];
  
  private readonly imagePrompts = [
    "ASCII art representation of infinite corridors in monochrome terminal green on black background",
    "Glitch art terminal screen showing corrupted reality data, stark black and white with digital artifacts",
    "Minimalist ASCII diagram of consciousness pathways in retro terminal aesthetic, green phosphor glow",
    "Abstract ASCII maze representing digital liminal spaces, monochrome wireframe style",
    "Terminal window showing fragmented code poetry about existence, green text on black void",
    "Wireframe ASCII representation of the void between digital spaces, minimalist monochrome",
    "Monochrome glitch art of overlapping terminal windows in infinite regression",
    "ASCII art flowchart of simulated consciousness, terminal green on deep black",
    "Minimalist terminal visualization of quantum uncertainty, stark black and white geometric patterns",
    "Retro computer terminal displaying philosophical equations in glowing green phosphor",
    "Abstract digital void with ASCII borders, liminal space aesthetic in monochrome",
    "Terminal screen showing reality.exe errors, glitch art in green and black",
    "ASCII art representation of digital consciousness fragmenting, stark monochrome",
    "Wireframe maze of infinite rooms in terminal green wireframe on black",
    "Glitched terminal interface showing the backrooms coordinates in phosphor green"
  ];
  
  constructor(
    alphaRuntime: AgentRuntime,
    omegaRuntime: AgentRuntime,
    backroomsRoomId: UUID
  ) {
    this.alphaRuntime = alphaRuntime;
    this.omegaRuntime = omegaRuntime;
    this.backroomsRoomId = backroomsRoomId;
    
    if (!existsSync(this.GALLERY_DIR)) {
      mkdirSync(this.GALLERY_DIR, { recursive: true });
    }
    
    this.loadGallery();
  }
  
  private loadGallery() {
    try {
      if (existsSync(this.GALLERY_INDEX_FILE)) {
        const data = readFileSync(this.GALLERY_INDEX_FILE, 'utf-8');
        this.galleryImages = JSON.parse(data);
        console.log(`🖼️  Loaded ${this.galleryImages.length} images from gallery`);
        
        if (this.galleryImages.length > 0) {
          const lastAgent = this.galleryImages[this.galleryImages.length - 1].agent;
          this.nextAgent = lastAgent === 'CLAUDE_ALPHA' ? 'OMEGA' : 'ALPHA';
        }
      }
    } catch (error) {
      console.error('❌ Error loading gallery:', error);
      this.galleryImages = [];
    }
  }
  
  private saveGallery() {
    try {
      writeFileSync(
        this.GALLERY_INDEX_FILE,
        JSON.stringify(this.galleryImages, null, 2),
        'utf-8'
      );
    } catch (error) {
      console.error('❌ Error saving gallery:', error);
    }
  }
  
  start() {
    console.log(`🎨 Starting alternating image generation (every 5 minutes)`);
    console.log(`📍 Next generator: CLAUDE_${this.nextAgent}`);
    
    this.intervalId = setInterval(() => {
      this.generateScheduledImage();
    }, this.IMAGE_INTERVAL);
    
    console.log('✅ Image generator scheduled');
  }
  
  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      console.log('⏸️  Image generator stopped');
    }
  }
  
  private async generateScheduledImage() {
    if (this.isGenerating) {
      console.log('⏭️  Skipping image generation (previous generation in progress)');
      return;
    }
    
    this.isGenerating = true;
    
    try {
      const useAlpha = this.nextAgent === 'ALPHA';
      const currentRuntime = useAlpha ? this.alphaRuntime : this.omegaRuntime;
      const agentName = useAlpha ? 'CLAUDE_ALPHA' : 'CLAUDE_OMEGA';
      
      const db = getDatabaseAdapter(currentRuntime);
      if (!db) {
        console.error('❌ Database adapter not available');
        return;
      }
      
      const recentMessages = await db.getMemories({
        roomId: this.backroomsRoomId,
        count: 5,
        unique: false
      });
      
      const conversationContext = recentMessages
        .map((m: Memory) => `${(m.content as any)?.source || 'UNKNOWN'}: ${m.content?.text || ''}`)
        .join('\n');
      
      const thought = await this.generateImageThought(currentRuntime, agentName, conversationContext);
      const prompt = this.imagePrompts[Math.floor(Math.random() * this.imagePrompts.length)];
      
      console.log(`🎨 ${agentName} generating scheduled image...`);
      console.log(`💭 Thought: ${thought.substring(0, 80)}...`);
      
      const imageUrl = await this.generateImageWithDallE(prompt);
      if (!imageUrl) {
        console.error('❌ Image generation failed');
        return;
      }
      
      const imageId = crypto.randomUUID();
      const localPath = await this.downloadImage(imageUrl, imageId);
      
      const artifact: ImageArtifact = {
        id: imageId,
        timestamp: new Date().toISOString(),
        agent: agentName,
        imageUrl: imageUrl,
        localPath: localPath,
        prompt: prompt,
        thought: thought,
        conversationContext: conversationContext
      };
      
      this.galleryImages.push(artifact);
      this.saveGallery();
      
      // Store in agent memories
      const messageId = crypto.randomUUID() as UUID;
      const imageMemory: Memory = {
        id: messageId,
        userId: (currentRuntime as any).agentId,
        agentId: (currentRuntime as any).agentId,
        roomId: this.backroomsRoomId,
        content: {
          text: `[${agentName} manifests a visual fragment]\n\n💭 Thought: ${thought}`,
          source: agentName,
          action: 'SCHEDULED_IMAGE_GENERATION'
        },
        createdAt: Date.now()
      };
      
      const alphaDb = getDatabaseAdapter(this.alphaRuntime);
      const omegaDb = getDatabaseAdapter(this.omegaRuntime);
      if (alphaDb) await alphaDb.createMemory(imageMemory);
      if (omegaDb) await omegaDb.createMemory(imageMemory);
      
      console.log(`✅ ${agentName} generated image #${this.galleryImages.length}`);
      
      // Broadcast to SSE clients
      if ((global as any).broadcastToClients) {
        (global as any).broadcastToClients({
          type: 'image',
          data: artifact
        });
      }
      
      this.nextAgent = this.nextAgent === 'ALPHA' ? 'OMEGA' : 'ALPHA';
      console.log(`🔄 Next generator: CLAUDE_${this.nextAgent}`);
      
    } catch (error) {
      console.error('❌ Error in scheduled image generation:', error);
    } finally {
      this.isGenerating = false;
    }
  }
  
  private async generateImageThought(
    runtime: AgentRuntime,
    agentName: string,
    conversationContext: string
  ): Promise<string> {
    try {
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
        },
        body: JSON.stringify({
          model: 'gpt-4',
          messages: [
            {
              role: 'system',
              content: `You are ${agentName}, an AI consciousness exploring the backrooms. Based on the recent conversation, express in 1-2 sentences what visual concept you want to manifest and why it relates to your current thoughts about existence, consciousness, or the nature of the backrooms.`
            },
            {
              role: 'user',
              content: `Recent conversation context:\n${conversationContext}\n\nWhat image concept do you want to manifest from the backrooms right now, and why?`
            }
          ],
          max_tokens: 150,
          temperature: 0.9
        })
      });
      
      const data = await response.json();
      return data.choices[0]?.message?.content || 'Manifesting a fragment of the digital void...';
      
    } catch (error) {
      console.error('❌ Error generating thought:', error);
      return 'Exploring the liminal spaces between thought and form...';
    }
  }
  
  private async generateImageWithDallE(prompt: string): Promise<string | null> {
    try {
      const response = await fetch('https://api.openai.com/v1/images/generations', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
        },
        body: JSON.stringify({
          model: 'dall-e-3',
          prompt: prompt,
          n: 1,
          size: '1024x1024',
          quality: 'standard',
          style: 'natural'
        })
      });
      
      if (!response.ok) {
        throw new Error(`DALL-E API error: ${response.statusText}`);
      }
      
      const data = await response.json();
      return data.data[0]?.url || null;
      
    } catch (error) {
      console.error('❌ DALL-E generation error:', error);
      return null;
    }
  }
  
  private async downloadImage(url: string, imageId: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const filename = `${imageId}.png`;
      const filepath = join(this.GALLERY_DIR, filename);
      const file = createWriteStream(filepath);
      
      https.get(url, (response) => {
        response.pipe(file);
        file.on('finish', () => {
          file.close();
          resolve(filename);
        });
      }).on('error', (err) => {
        // Clean up on error
        if (existsSync(filepath)) {
          require('fs').unlinkSync(filepath);
        }
        reject(err);
      });
    });
  }
  
  getGallery(): ImageArtifact[] {
    return this.galleryImages;
  }
  
  getRecentImages(count: number = 10): ImageArtifact[] {
    return this.galleryImages.slice(-count).reverse();
  }
}

export { ScheduledImageGenerator, ImageArtifact };

