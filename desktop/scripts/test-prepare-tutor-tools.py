# SPDX-License-Identifier: MIT
import importlib.util,unittest,tempfile,pathlib,tarfile,io,hashlib
spec=importlib.util.spec_from_file_location('prepare',pathlib.Path(__file__).with_name('prepare-tutor-tools.py'));prepare=importlib.util.module_from_spec(spec);spec.loader.exec_module(prepare)
class Boundaries(unittest.TestCase):
    def test_archive_digest_and_offline(self):
        with tempfile.TemporaryDirectory() as temp:
            root=pathlib.Path(temp);p=root/'asset.tar.gz';p.write_bytes(b'abc')
            asset={'name':p.name,'size':3,'sha256':hashlib.sha256(b'abc').hexdigest()}
            self.assertEqual(prepare.archive(asset,root,True),p)
            p.write_bytes(b'bad')
            with self.assertRaisesRegex(ValueError,'SHA256'):prepare.archive(asset,root,True)
            p.unlink()
            with self.assertRaisesRegex(ValueError,'missing'):prepare.archive(asset,root,True)
    def test_paths_links_and_special_files_before_extraction(self):
        for name,kind,link in [('../escape','file',''),('/absolute','file',''),('other/file','file',''),('sdk/link','link','../../escape'),('sdk/fifo','fifo','')]:
            with self.subTest(name=name),tempfile.TemporaryDirectory() as temp:
                root=pathlib.Path(temp);archive=root/'bad.tar';dest=root/'extract';dest.mkdir()
                with tarfile.open(archive,'w') as t:
                    m=tarfile.TarInfo(name)
                    if kind=='link':m.type=tarfile.SYMTYPE;m.linkname=link
                    if kind=='fifo':m.type=tarfile.FIFOTYPE
                    t.addfile(m,io.BytesIO())
                with self.assertRaises(ValueError):prepare.extract(archive,dest,'sdk')
                self.assertEqual(list(dest.iterdir()),[])
    def test_internal_link_and_existing_destination(self):
        with tempfile.TemporaryDirectory() as temp:
            root=pathlib.Path(temp);dest=root/'extract';dest.mkdir();archive=root/'good.tar'
            with tarfile.open(archive,'w') as t:
                m=tarfile.TarInfo('sdk/bin/clang-23');m.size=3;t.addfile(m,io.BytesIO(b'abc'))
                m=tarfile.TarInfo('sdk/bin/clang');m.type=tarfile.SYMTYPE;m.linkname='clang-23';t.addfile(m)
            prepare.extract(archive,dest,'sdk');prepare.copy_inside(dest/'sdk','bin/clang',root/'copy')
            self.assertEqual((root/'copy').read_bytes(),b'abc');self.assertFalse((root/'copy').is_symlink())
            with self.assertRaisesRegex(ValueError,'Destination exists'):prepare.prepare('darwin-arm64',root,dest,True)
if __name__=='__main__':unittest.main()
