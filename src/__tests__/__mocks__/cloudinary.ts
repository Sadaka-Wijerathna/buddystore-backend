// Mock Cloudinary — tests don't upload to cloud
export const uploadBanner = jest.fn().mockResolvedValue({ secure_url: 'https://res.cloudinary.com/test/banner.jpg' });
export const uploadReceipt = jest.fn().mockResolvedValue({ secure_url: 'https://res.cloudinary.com/test/receipt.jpg' });
export const uploadMedia = jest.fn().mockResolvedValue({ secure_url: 'https://res.cloudinary.com/test/media.jpg' });
export const uploadThumbnail = jest.fn().mockResolvedValue({ secure_url: 'https://res.cloudinary.com/test/thumb.jpg' });
export const uploadPdf = jest.fn().mockResolvedValue({ secure_url: 'https://res.cloudinary.com/test/doc.pdf' });
export const deleteCloudinaryImages = jest.fn().mockResolvedValue(undefined);

const cloudinaryMock = {
  uploadBanner,
  uploadReceipt,
  uploadMedia,
  uploadThumbnail,
  uploadPdf,
  deleteCloudinaryImages,
  uploader: {
    destroy: jest.fn().mockResolvedValue({ result: 'ok' }),
  },
};

export default cloudinaryMock;
