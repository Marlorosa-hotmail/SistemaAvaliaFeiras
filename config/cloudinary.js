const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// PDFs / relatórios
const storagePdf = new CloudinaryStorage({
  cloudinary,
  params: async (req, file) => ({
    folder: 'relatorios_projetos',
    resource_type: 'raw',
    public_id: file.originalname.replace(/\.[^/.]+$/, '')
  }),
});

// Logos / imagens
const storageLogo = new CloudinaryStorage({
  cloudinary,
  params: async (req, file) => ({
    folder: 'logos_escolas',
    resource_type: 'image',
    public_id: file.originalname.replace(/\.[^/.]+$/, '')
  }),
});

module.exports = {
  cloudinary,
  storagePdf,
  storageLogo
};
