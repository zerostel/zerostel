# Homebrew formula for Zerostel. Generated from this template by
# `node scripts/release-manifests.mjs <version>` after the npm release;
# __VERSION__ and __SHA256__ are filled in from the published tarball.
class Zerostel < Formula
  desc "Rewind any AI coding agent to point zero"
  homepage "https://github.com/zerostel/zerostel"
  url "https://registry.npmjs.org/zerostel/-/zerostel-__VERSION__.tgz"
  sha256 "__SHA256__"
  license "Apache-2.0"

  depends_on "git"
  depends_on "node"

  def install
    system "npm", "install", *std_npm_args
    bin.install_symlink Dir["#{libexec}/bin/*"]
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/zerostel --version")
    system bin/"zerostel", "doctor", "--json"
  end
end
